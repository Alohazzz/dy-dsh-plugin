/** @param {string} title */
export function sectionName(title) {
  const plain = title.trim().replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/[：:]\s*$/, '').trim()
  return plain.replace(/^(?:[（(][一二三四五六七八九十百\d０-９]+[)）]|[一二三四五六七八九十百\d０-９]+[、.．)）])\s*/u, '')
}
