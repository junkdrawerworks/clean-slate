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

// add(strokes) puts strokes on the board, remove(ids) takes strokes off it, has(ids) says whether any of those
// strokes is on it, and find(stroke) gives the stroke on the board that draws the same under another id, if there is one.
//
// A line can leave the board without this device's undo: another device erased it, and the merge took it away here.
// Undoing that line's step would change nothing, so undo passes over such steps (onto the redo list, as if undone) and
// undoes the next one, and Undo is greyed out when only those are left. Redo is the same the other way: a step that
// would only take away lines another device has already taken away would change nothing, so redo drops it (rather than
// moving it onto the undo list, where undoing it would put back a line the other device erased) and redoes the next
// one, and Redo is greyed out when only those are left.
//
// Two devices can put back the same stroke, each as a copy of its own. When they meet, the merge keeps one of the two
// (see mergeBoards in board.js). So a stroke to put back whose drawing is on the board already (the other device put it
// back) isn't added again, and a step with nothing left to put back has nothing to do. A stroke a step names that the
// merge took away for its twin is taken away as that twin.
//
// Undoing or redoing a step lets go of the strokes in it that it found nothing to do with: a line to take away that
// another device has erased, or a line to put back that another device has put back. So the step done the other way
// round leaves those lines be, and undo then redo (or redo then undo) gives back the board as it was, and never puts
// back a line another device erased.
export function makeHistory({ add, remove, has = () => true, find = () => null }) {
  const undos = [], redos = [];
  // The stroke on the board that stands for s: s itself, or the twin the merge kept instead.
  const on = s => (has([s.id]) ? s : find(s));
  // (The strokes a step puts back are never on the board under their own ids: they were taken away.)
  const empty = step => !step.add?.some(on) && !step.remove?.some(s => !find(s));
  const emptyRedo = step => !step.remove?.some(on) && !step.add?.some(s => !find(s));
  function apply(step, backwards) {
    const adding = backwards ? step.remove : step.add;
    const taking = backwards ? step.add : step.remove;
    const swap = new Map(), copies = [], left = new Set();
    for (const s of taking || []) { const t = on(s); if (!t) left.add(s.id); else if (t !== s) swap.set(s.id, t); }
    for (const s of adding || []) {
      if (find(s)) { left.add(s.id); continue; }
      const copy = again(s);
      swap.set(s.id, copy);
      copies.push(copy);
    }
    if (left.size) for (const k of ['add', 'remove']) if (step[k]) step[k] = step[k].filter(s => !left.has(s.id));
    if (taking?.length) remove(taking.filter(s => !left.has(s.id)).map(s => (swap.get(s.id) || s).id));
    if (swap.size) {
      const named = list => list && list.map(s => swap.get(s.id) || s);
      for (const st of [step, ...undos, ...redos]) {
        if (st.add) st.add = named(st.add);
        if (st.remove) st.remove = named(st.remove);
      }
    }
    if (copies.length) add(copies);
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
      while (redos.length && emptyRedo(redos[redos.length - 1])) redos.pop();
      const step = redos.pop();
      if (!step) return false;
      apply(step, false);
      undos.push(step);
      return true;
    },
    canUndo: () => undos.some(step => !empty(step)),
    canRedo: () => redos.some(step => !emptyRedo(step)),
  };
}
