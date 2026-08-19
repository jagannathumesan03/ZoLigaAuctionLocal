const PLAYER_AFFILIATIONS = [
  'Zoho Chennai',
  'Zoho Kottarakara',
  'Ex Zoho',
  'Ex ZoLiga',
];

const AFFILIATION_SLUGS = {
  'Zoho Chennai': 'zoho-chennai',
  'Zoho Kottarakara': 'zoho-kottarakara',
  'Ex Zoho': 'ex-zoho',
  'Ex ZoLiga': 'ex-zoliga',
};

function normalizeAffiliation(raw) {
  const text = (raw || '').trim();
  if (!text) return '';
  const match = PLAYER_AFFILIATIONS.find(a => a.toLowerCase() === text.toLowerCase());
  return match || text;
}

function affiliationSlug(label) {
  return AFFILIATION_SLUGS[label] || label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function affiliationBadgeHtml(stats, extraClass = '') {
  const label = normalizeAffiliation(stats);
  if (!label) return '';
  const cls = extraClass ? ` ${extraClass}` : '';
  return `<span class="affiliation-badge affiliation-${affiliationSlug(label)}${cls}">${escapeHtml(label)}</span>`;
}
