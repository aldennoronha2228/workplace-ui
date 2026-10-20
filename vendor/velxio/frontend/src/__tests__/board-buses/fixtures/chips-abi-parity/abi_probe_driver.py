"""Replay the cross-host ABI table against a Python host (board-buses F7).

Lives next to the artifact and the table it drives, because the point of the
fixture is that ONE wasm and ONE list of expected answers reach every host. The
QEMU-worker suite (test_wasm_chip_abi_parity.py) and the Linux-board suite
(pro test_board_buses_abi_parity_pi.py) import this; the browser suite does the
same walk in TypeScript (board-buses-abi-parity.test.ts).

`WorkerHost` drives a WasmChipRuntime exactly as esp32_worker.py and
stm32_worker.py do: the select is read through spi_cs_active and the byte goes
through spi_transfer_byte, an I2C event goes through the I2cBusTable into a
WasmChipI2CSlave, a UART byte through feed_uart_byte, a pad edge through
notify_pin_change, and the timers through fire_due_timers on the clock the
runtime was given. Nothing here reaches into the runtime past that surface.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Callable

from app.services.i2c_bus_table import I2cBusTable
from app.services.wasm_chip_runtime import WasmChipRuntime
from app.services.wasm_chip_slave import WasmChipI2CSlave

HERE = Path(__file__).resolve().parent
WASM = HERE / "abi-probe.wasm"
TABLE = json.loads((HERE / "expectations.json").read_text())

I2C_START_RECV, I2C_START_SEND, I2C_FINISH, I2C_WRITE, I2C_READ = 0x00, 0x01, 0x03, 0x05, 0x06

# The chip's own pin indices (abi-probe.c, pick_pin) and the names it registers.
PIN_NAMES = ["IN", "OUT", "DIR", "CS", "CS2"]

_KIND = {1: "spi_done", 2: "spi_rx", 3: "spi_xchg", 4: "i2c_connect", 5: "i2c_write",
         6: "i2c_read", 7: "i2c_stop", 8: "uart_rx", 9: "uart_tx_done", 10: "pin",
         11: "timer"}


def decode_record(kind: int, a: int, b: int, c: int) -> str:
    """One trace record as the table spells it. The same words as the
    TypeScript decoder, so a row reads the same in every suite's output."""
    k = _KIND.get(kind, f"kind{kind}")
    if k == "spi_done":
        buf = "own" if c == a else ("none" if c == 2 else "other")
        return f"spi_done h={a} n={b} buf={buf}"
    if k == "spi_rx":
        return f"spi_rx {a}={b:02x}"
    if k == "spi_xchg":
        return f"spi_xchg {a:02x}->{b:02x}"
    if k == "i2c_connect":
        return f"i2c_connect slot={a} addr={b:02x} read={c}"
    if k == "i2c_write":
        return f"i2c_write slot={a} {b:02x}"
    if k == "i2c_read":
        return f"i2c_read slot={a} ->{b:02x}"
    if k == "i2c_stop":
        return f"i2c_stop slot={a}"
    if k == "uart_rx":
        return f"uart_rx {a:02x}"
    if k == "uart_tx_done":
        return "uart_tx_done"
    if k == "pin":
        return f"pin {PIN_NAMES[a] if a < len(PIN_NAMES) else a}={b}"
    if k == "timer":
        return f"timer now={(b << 32) | a}"
    return f"{k} {a} {b} {c}"


class Probe:
    """The probe surface abi-probe.c exports, over a runtime."""

    def __init__(self, runtime: WasmChipRuntime) -> None:
        self.rt = runtime

    def call(self, name: str, *args: int) -> int:
        fn = self.rt._exports[name]
        # A probe call runs wasm, which can move the memory: the runtime's
        # own entry points drop their view first, and so does this one.
        self.rt._drop_mem_view()
        r = fn(self.rt._store, *args)
        self.rt._drop_mem_view()
        self.rt._flush_stdout()
        return int(r or 0) if r is not None else 0

    def scratch(self, n: int) -> bytes:
        return self.rt._read_bytes(self.call("scratch_ptr"), n)

    def poke(self, data: bytes) -> None:
        self.rt._write_bytes(self.call("scratch_ptr"), data)

    def trace(self) -> list[str]:
        n = self.call("trace_count")
        ptr = self.call("trace_ptr")
        raw = self.rt._read_bytes(ptr, n * 16)
        out = []
        for i in range(n):
            kind, a, b, c = (int.from_bytes(raw[i * 16 + j * 4:i * 16 + j * 4 + 4], "little")
                             for j in range(4))
            out.append(decode_record(kind, a, b, c))
        self.call("trace_clear")
        return out


class WorkerHost:
    """A QEMU worker's plumbing around one chip, minus QEMU."""

    def __init__(self, blobs: dict[str, bytes] | None = None,
                 attrs: dict | None = None) -> None:
        self.pins: dict[str, int] = dict(TABLE["pins"])
        self.gpio_name = {v: k for k, v in self.pins.items()}
        # What the guest last put on each pad, as the worker's _pin_state has
        # it: a pad the guest never touched is absent, not 0.
        self.levels: dict[int, int] = {}
        # What the chip drove into QEMU (qemu_picsimlab_set_pin), by gpio.
        self.board: dict[int, int] = {}
        self.uart_out = bytearray()
        self.logs: list[str] = []
        self.now = [0]
        self.rt = WasmChipRuntime(
            WASM.read_bytes(),
            attrs if attrs is not None else {},
            self._emit,
            pin_map=dict(self.pins),
            pin_writer=lambda gpio, v: self.board.__setitem__(int(gpio), int(v) & 1),
            pin_reader=lambda gpio: self.levels.get(int(gpio)),
            uart_writer=lambda data: self.uart_out.extend(data),
            timer_scheduler=None,
            blobs=blobs,
            component_id="abi",
            clock=lambda: self.now[0],
        )
        self.rt.run_chip_setup()
        self.probe = Probe(self.rt)
        # The I2C side, as the worker registers it: one slave for every
        # address the chip attached, on the table that dispatches by
        # (controller, address).
        self.i2c = I2cBusTable()
        if self.rt.i2c_address is not None:
            slave = WasmChipI2CSlave(self.rt.i2c_address, self.rt)
            self.i2c.add(("sensor", 400), slave, self.rt.i2c_addresses, owner="abi", bus=0)
        self._i2c_addr = 0

    def _emit(self, ev: dict) -> None:
        if ev.get("type") == "chip_log":
            self.logs.append(str(ev.get("text", "")).rstrip("\n"))

    # ── the ops ─────────────────────────────────────────────────────────

    def drive(self, name: str, level: int) -> None:
        gpio = self.pins[name]
        self.levels[gpio] = level & 1
        self.rt.notify_pin_change(gpio, level & 1)

    def pad(self, name: str, pull: str) -> None:
        """The guest configures a pad as an input with a pull. The worker has
        no pad model: QEMU reports levels, never a direction with a pull, so
        nothing here changes and the rows that depend on it say so."""
        return None

    def spi(self, mosi: list[int]) -> list[int]:
        """The worker's per-byte answer: the selected handles of this chip,
        the way _spi_answer arbitrates its responders."""
        out = []
        for b in mosi:
            selected = [h for h in range(self.rt.spi_handle_count()) if self.rt.spi_cs_active(h)]
            if not selected:
                out.append(0xFF)
                continue
            v = 0xFF
            for h in selected:
                v &= self.rt.spi_transfer_byte(b & 0xFF, h) & 0xFF
            out.append(v)
        return out

    def i2c_seq(self, seq: list) -> list:
        """Run one table sequence through the bus table; returns what the
        controller saw per element (ack, ack, byte, None)."""
        got = []
        for el in seq:
            op = el[0]
            if op == "start":
                addr, read = int(el[1]), bool(el[2])
                self._i2c_addr = addr
                r = self.i2c.event(0, addr, I2C_START_RECV if read else I2C_START_SEND)
                got.append(r == 0)
            elif op == "write":
                r = self.i2c.event(0, self._i2c_addr, I2C_WRITE | ((int(el[1]) & 0xFF) << 8))
                got.append(r == 0)
            elif op == "read":
                r = self.i2c.event(0, self._i2c_addr, I2C_READ)
                got.append(None if r is None else int(r) & 0xFF)
            elif op == "stop":
                self.i2c.event(0, self._i2c_addr, I2C_FINISH)
                got.append(None)
            else:
                raise AssertionError(f"not an i2c element: {el}")
        return got

    def uart_rx(self, data: list[int]) -> None:
        for b in data:
            self.rt.feed_uart_byte(b)

    def board_pin(self, name: str):
        v = self.board.get(self.pins[name])
        return None if v is None else int(v)

    def clock(self, ns: int) -> None:
        """The guest clock reaches `ns`: the worker's timer thread fires what
        is due, and keeps firing while a deadline it passed is still due."""
        self.now[0] = int(ns)
        for _ in range(10_000):
            d = self.rt.next_timer_deadline()
            if d is None or d > self.now[0]:
                break
            self.rt.fire_due_timers()

    def attr(self, name: str, value: float) -> None:
        self.rt.update_attrs({name: float(value)})

    def volts(self, pin: str, volts) -> None:
        """The tab's solve on a pad, as the worker receives it: a pad_volts
        table keyed by the chip's pin names, None for a wire that is gone."""
        self.rt.update_pad_volts({pin: volts})


HOST_KEY = "worker"


def expected(step: dict, host: str) -> dict:
    """The row as this host must answer it: the shared fields, with the
    host's own variant laid over them when the table names one."""
    row = {k: v for k, v in step.items() if k != "hosts"}
    hosts = step.get("hosts") or {}
    if host in hosts:
        row.update({k: v for k, v in hosts[host].items() if k != "why"})
    return row


def i2c_expected(seq: list) -> list:
    out = []
    for el in seq:
        if el[0] == "start":
            out.append(bool(el[3]))
        elif el[0] == "write":
            out.append(bool(el[2]))
        elif el[0] == "read":
            out.append(int(el[1]))
        else:
            out.append(None)
    return out


def scenarios_for(host_key: str) -> list[dict]:
    """The scenarios a host can drive: every one, minus those whose `only`
    leaves it out (and says why)."""
    return [s for s in TABLE["scenarios"] if host_key in s.get("only", [host_key])]


def replay(host, scenario: dict, host_key: str = HOST_KEY) -> list[str]:
    """Walk one scenario. Returns one line per row that answered differently,
    so a failing host names every divergence at once."""
    bad: list[str] = []
    probe = host.probe
    for i, raw in enumerate(scenario["steps"]):
        st = expected(raw, host_key)
        label = f"step {i} {json.dumps({k: v for k, v in raw.items() if k not in ('why', 'hosts')})}"
        if st.get("skip"):
            continue
        op = st["op"]
        if op == "call":
            got = probe.call(st["fn"], *[int(a) for a in st.get("args", [])])
            if "ret" in st and got != st["ret"]:
                bad.append(f"{label}: returned {got}, table says {st['ret']}")
            if "scratchHex" in st:
                seen = probe.scratch(len(st["scratchHex"]) // 2).hex()
                if seen != st["scratchHex"]:
                    bad.append(f"{label}: scratch {seen}, table says {st['scratchHex']}")
            if "board_rx" in st:
                seen_rx = list(host.uart_out)
                host.uart_out.clear()
                if seen_rx != list(st["board_rx"]):
                    bad.append(f"{label}: the board heard {seen_rx}, table says {st['board_rx']}")
        elif op == "drive":
            host.drive(st["pin"], int(st["level"]))
        elif op == "pad":
            host.pad(st["pin"], str(st["pull"]))
        elif op == "spi":
            got = host.spi(list(st["mosi"]))
            if got != list(st["miso"]):
                bad.append(f"{label}: miso {got}, table says {st['miso']}")
        elif op == "i2c":
            got = host.i2c_seq(st["seq"])
            want = i2c_expected(st["seq"])
            if st.get("acks", True) is False:
                # A host whose write phase reports no ACK: compare the bytes read.
                is_byte = lambda w: isinstance(w, int) and not isinstance(w, bool)  # noqa: E731
                got = [g for g, w in zip(got, want) if is_byte(w)]
                want = [w for w in want if is_byte(w)]
            if got != want:
                bad.append(f"{label}: the controller saw {got}, table says {want}")
        elif op == "ce":
            got = host.ce(list(st["mosi"]), bool(st.get("hold", False)))
            if got != list(st["miso"]):
                bad.append(f"{label}: miso {got}, table says {st['miso']}")
        elif op == "uart_rx":
            host.uart_rx([int(b) for b in st["bytes"]])
        elif op == "board_pin":
            got = host.board_pin(st["pin"])
            if got != st["expect"]:
                bad.append(f"{label}: the board sees {got!r}, table says {st['expect']!r}")
        elif op == "clock":
            host.clock(int(st["ns"]))
        elif op == "attr":
            host.attr(st["name"], float(st["value"]))
        elif op == "volts":
            host.volts(st["pin"], st.get("volts"))
        elif op == "poke":
            probe.poke(bytes.fromhex(st["hex"]))
        elif op == "trace":
            got = probe.trace()
            if got != list(st["expect"]):
                bad.append(f"{label}: trace {got}, table says {st['expect']}")
        else:
            raise AssertionError(f"unknown op {op!r} in {label}")
    return bad
