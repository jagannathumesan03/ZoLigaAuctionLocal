const PLAYER_POSITIONS = [
  { value: 'GK', label: 'Goalkeeper' },
  { value: 'DEF', label: 'Defender' },
  { value: 'MID', label: 'Midfielder' },
  { value: 'FW', label: 'Forward' },
];

const ROLE_TOKEN_ABBREV = {
  forward: 'FW', fwd: 'FW', fw: 'FW', st: 'FW', striker: 'FW', attacker: 'FW',
  midfielder: 'MID', middle: 'MID', mid: 'MID', cm: 'MID',
  defender: 'DEF', defence: 'DEF', defense: 'DEF', cb: 'DEF', def: 'DEF',
  goalkeeper: 'GK', keeper: 'GK', gk: 'GK',
};

const ROLE_PATTERN_ABBREV = [
  { value: 'GK', pattern: /goalkeeper|keeper|\bgk\b/i },
  { value: 'DEF', pattern: /defender|defence|defense|\bcb\b|\bdef\b/i },
  { value: 'MID', pattern: /midfielder|midfield|middle|\bmid\b|\bcm\b/i },
  { value: 'FW', pattern: /forward|\bfwd\b|\bfw\b|striker|\bst\b|attacker/i },
];

function roleAbbreviation(role) {
  const positions = parsePlayerPositions(role);
  return positions[0] || '-';
}

/** All positions a player can play (multi-role strings show under each filter). */
function parsePlayerPositions(role) {
  const text = String(role || '').trim();
  if (!text) return [];

  const found = [];
  ROLE_PATTERN_ABBREV.forEach(({ value, pattern }) => {
    if (pattern.test(text) && !found.includes(value)) found.push(value);
  });
  if (found.length) return found;

  const normalizedRole = text.toLowerCase();
  if (ROLE_TOKEN_ABBREV[normalizedRole]) return [ROLE_TOKEN_ABBREV[normalizedRole]];

  const short = normalizedRole.slice(0, 3).toUpperCase();
  if (short === 'FWD') return ['FW'];
  if (PLAYER_POSITIONS.some(p => p.value === short)) return [short];
  return [];
}

function playerHasPosition(role, positionValue) {
  if (!positionValue) return true;
  return parsePlayerPositions(role).includes(positionValue);
}
