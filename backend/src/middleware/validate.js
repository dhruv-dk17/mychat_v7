function validateSlug(slug) {
  if (!slug || typeof slug !== 'string') return false;
  if (slug.length < 3 || slug.length > 8) return false;
  return /^[a-z0-9]+$/.test(slug);
}

function validateHash(hash) {
  if (!hash || typeof hash !== 'string') return false;
  return /^[a-f0-9]{64}$/.test(hash);
}

module.exports = { validateSlug, validateHash };
