// Assigns each commit (newest first, as git log --date-order prints them) a lane and the line segments
// its row draws. lanes[i] holds the hash lane i is waiting for; a commit takes the lane waiting for it,
// its first parent inherits that lane, and every other parent joins the lane already waiting for it or opens one.
// Line kinds: 'pass' crosses the whole row, 'in' runs from the row top into the dot, 'out' from the dot to the row bottom.
export function layoutGraph(commits) {
  const lanes = [];
  const colors = [];
  let nextColor = 0;
  const freeLane = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  const open = (lane, hash) => {
    lanes[lane] = hash;
    colors[lane] = nextColor++;
  };

  return commits.map((commit) => {
    let lane = lanes.indexOf(commit.hash);
    const isTip = lane === -1;
    if (isTip) open((lane = freeLane()), commit.hash);
    const color = colors[lane];
    const lines = [];

    lanes.forEach((hash, i) => {
      if (hash === null) return;
      if (hash !== commit.hash) lines.push({ fromLane: i, toLane: i, color: colors[i], kind: 'pass' });
      else if (!(isTip && i === lane)) lines.push({ fromLane: i, toLane: lane, color: colors[i], kind: 'in' });
    });
    lanes.forEach((hash, i) => { if (hash === commit.hash) lanes[i] = null; });

    commit.parents.forEach((parent, k) => {
      let to = lane;
      if (k === 0) lanes[lane] = parent;
      else {
        to = lanes.indexOf(parent);
        if (to === -1) open((to = freeLane()), parent);
      }
      lines.push({ fromLane: lane, toLane: to, color: colors[to], kind: 'out' });
    });

    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    const width = Math.max(lane, ...lines.map((l) => Math.max(l.fromLane, l.toLane))) + 1;
    return { commit, lane, color, lines, width };
  });
}
