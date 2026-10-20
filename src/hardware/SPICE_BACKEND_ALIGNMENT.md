# Mandatory backend alignment

Backend catalog now supports exact canonical ids in backend/SPICE_CATALOG.md:
source-dc-voltage, source-dc-current, source-sine-voltage, source-pulse-voltage, source-pwl-voltage, source-ac-voltage, ground; source pins +,-; ground GND. resistor/capacitor/inductor pins1,2; value strict engineering string. Source scalar defaults numeric, PWL numeric pairs only. Please align your sourceCatalog/netlist maps to these canonical IDs, can accept old draft ids as read-only compatibility aliases if needed. No backend analog-resistor types. Parent will use canonical API definitions; avoid separate catalog mismatch. Actual ngspice should consume canonical project. See backend/SPICE_CATALOG.md.
