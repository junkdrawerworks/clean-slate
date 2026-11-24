// Undo and redo for one board, with no page in sight (so test/unit.test.mjs can run it in Node).
//
// A step is the strokes one action added and the strokes it took away: { add: [...] } for a line, { remove: [...] }
// for the eraser or Clear. Undoing a step takes away what it added and puts back what it took away; redoing it does
// the opposite. A stroke taken away stays taken away under its id on every device that saw it go (see board.js), so
// putting one back means adding a copy under a new id. From then on that copy is the stroke on the board, so every
// step still remembered, undo and redo alike, is changed to name the copy instead of the old id. Without that, undoing
// an earlier step would try to take away the old id (already gone, so nothing happens) and redoing one would add a
// second copy.
import { again } from './board.js';

export const STEPS = 300; // the most steps remembered for one board

// add(strokes) puts strokes on the board, remove(ids) takes strokes off it, and has(ids) says whether any of those
// strokes is on it.
//
// A line can leave the board without this device's undo: another device erased it, and the merge took it away here.
// Undoing that line's step would change nothing, so undo passes over such steps (onto the redo list, as if undone) and
// undoes the next one, and Undo is greyed out when only those are left. Redo is as it was: it puts back this device's
// own lines.
export function makeHistory({ add, remove, has = () => true }) {
  const undos = [], redos = [];
  const empty = step => !step.remove?.length && !!step.add?.length && !has(step.add.map(s => s.id));
  function apply(step, backwards) {
    const adding = backwards ? step.remove : step.add;
    const taking = backwards ? step.add : step.remove;
    if (taking?.length) remove(taking.map(s => s.id));
    if (adding?.length) {
      const copies = adding.map(again);
      const swap = new Map(adding.map((s, i) => [s.id, copies[i]]));
      const named = list => list && list.map(s => swap.get(s.id) || s);
      for (const st of [step, ...undos, ...redos]) {
        if (st.add) st.add = named(st.add);
        if (st.remove) st.remove = named(st.remove);
      }
      add(copies);
    }
  }
  return {
    remember(step) {
      undos.push(step);
      if (undos.length > STEPS) undos.shift();
      redos.length = 0;
    },
    undo() {
      let i = undos.length - 1;
      while (i >= 0 && empty(undos[i])) i--;
      if (i < 0) return false;
      while (undos.length > i + 1) redos.push(undos.pop());
      const step = undos.pop();
      apply(step, true);
      redos.push(step);
      return true;
    },
    redo() {
      const step = redos.pop();
      if (!step) return false;
      apply(step, false);
      undos.push(step);
      return true;
    },
    canUndo: () => undos.some(step => !empty(step)),
    canRedo: () => redos.length > 0,
  };
}
