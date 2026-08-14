/**
 * The playground: one room at a room boundary, the pre-mansion flow.
 *
 * The room itself -- the drag/tap gesture, the tray, the clamping -- lives in
 * room_canvas.js, which the mansion shares. This is the jsPsych wrapper around
 * it: one room, one "All done!", straight back into the trials.
 */

import { mountRoomCanvas, stickerHtml } from "./room_canvas.js";

export { stickerHtml };

export class PlaygroundPlugin {
  static info = {
    name: "castle-playground",
    version: "1.0.0",
    parameters: {
      backdrop: { type: "STRING", default: "" },
      pending: { type: "OBJECT", array: true, default: [] },
      placed: { type: "OBJECT", array: true, default: [] },
      prompt: { type: "STRING", default: "Put them anywhere you like!" },
      room_index: { type: "INT", default: 0 },
    },
    data: {
      placements: { type: "OBJECT", array: true },
      playground_ms: { type: "FLOAT" },
      room_index: { type: "INT" },
    },
  };

  constructor(jsPsych) { this.jsPsych = jsPsych; }

  trial(display, trial) {
    const t0 = performance.now();
    const room = mountRoomCanvas(display, {
      backdrop: trial.backdrop,
      pending: trial.pending,
      placed: trial.placed,
      prompt: trial.prompt,
      roomIndex: trial.room_index,
      buttons: [
        { id: "done", label: "✅ All done!", cls: "big" },
      ],
      onButton: (id, events) => {
        if (id !== "done") return;
        room.destroy();
        display.innerHTML = "";
        this.jsPsych.finishTrial({
          placements: events,
          playground_ms: performance.now() - t0,
          room_index: trial.room_index,
        });
      },
    });
  }
}
