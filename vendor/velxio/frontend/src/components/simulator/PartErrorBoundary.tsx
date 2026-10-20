/**
 * One part on the canvas, fenced off from the rest of the editor.
 *
 * The app has no error boundary above the canvas, and React unmounts the
 * whole root when a render or an effect throws with nothing to catch it. A
 * part is third-party-shaped code (a wokwi element, a data-driven overlay
 * brick, a board drawing), and its element is read from effects all over the
 * canvas (pins, seating, wires). One part that throws there used to cost the
 * user the entire editor: a blank page on every load of that project, with no
 * canvas left to delete the part from.
 *
 * A part that throws now draws as a small dashed box where it sits. The box
 * still takes a click and a right click, so the part can be selected, inspected
 * and deleted, and the boundary tries again whenever the part's properties
 * change (an edit, an undo), which is how a fixed value brings it back.
 */
import React from 'react';

interface Props {
  partId: string;
  label: string;
  x: number;
  y: number;
  /** Changes when the part's properties change: the boundary retries. */
  resetKey: unknown;
  onMouseDown?: (e: React.MouseEvent) => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}

interface State {
  failed: boolean;
  resetKey: unknown;
}

export class PartErrorBoundary extends React.Component<Props, State> {
  state: State = { failed: false, resetKey: this.props.resetKey };

  static getDerivedStateFromError(): Partial<State> {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.resetKey) return { failed: false, resetKey: props.resetKey };
    return null;
  }

  componentDidCatch(error: unknown): void {
    console.error(`[part] ${this.props.label} (${this.props.partId}) failed to draw:`, error);
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div
        className="part-error-fallback"
        data-part-error={this.props.partId}
        role="img"
        aria-label={`${this.props.label} could not be drawn`}
        title={`${this.props.label} could not be drawn`}
        onMouseDown={this.props.onMouseDown}
        onContextMenu={this.props.onContextMenu}
        style={{
          position: 'absolute',
          left: this.props.x,
          top: this.props.y,
          width: 40,
          height: 40,
          border: '1px dashed #d9534f',
          borderRadius: 4,
          background: 'rgba(217, 83, 79, 0.08)',
          cursor: 'pointer',
        }}
      />
    );
  }
}
