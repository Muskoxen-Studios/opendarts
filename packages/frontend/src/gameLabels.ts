const labels: Record<string, string> = {
  x01: 'X01', cricket: 'Cricket', golf: 'Golf', gotcha: 'Gotcha', shanghai: 'Shanghai',
  killer: 'Killer', evenodd: 'Even/Odd', minefield: 'Minefield', conquest: 'Conquest',
  countup: 'Count Up', aroundtheclock: 'Around the Clock', randomcheckout: 'Random Checkout',
  roundtheworld: 'Round the World', segmenttraining: 'Segment Training', bobs27: "Bob's 27", '121': '121',
};
export function gameLabel(gameType: string): string { return labels[gameType] ?? gameType.toUpperCase(); }
