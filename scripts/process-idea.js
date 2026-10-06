// scripts/process-idea.js
//
// Called from the GitHub Actions workflow via actions/github-script.
// Reads the new idea from the issue body, checks it against ideas/index.json
// using keyword overlap, and either flags it as a duplicate or stores it
// as a new file under ideas/.

const fs = require('fs');
const path = require('path');

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'have', 'will', 'would', 'should',
  'about', 'which', 'there', 'their', 'into', 'also', 'when', 'where',
  'what', 'while', 'your', 'than', 'them', 'they', 'been', 'were', 'being'
]);

// Pull meaningful words out of free text: lowercase, 4+ letters, no stopwords, deduped.
function extractKeywords(text) {
  return [...new Set(
    text.toLowerCase()
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
  )];
}

// Jaccard similarity: overlap size / union size. 0 = no shared words, 1 = identical sets.
function jaccardSimilarity(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  const intersectionSize = [...setA].filter((x) => setB.has(x)).length;
  const unionSize = new Set([...setA, ...setB]).size;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

// GitHub Issue Forms render each field as "### Label\n\nvalue" in the issue body.
function getField(body, label) {
  const regex = new RegExp(`### ${label}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`, 'i');
  const match = body.match(regex);
  return match ? match[1].trim() : '';
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 6)
    .join('-');
}

// Tune this to control strictness. Lower = catches more possible duplicates
// (more false positives). Higher = stricter (may miss reworded duplicates).
const SIMILARITY_THRESHOLD = 0.35;

module.exports = async ({ github, context, core }) => {
  const indexPath = path.join('ideas', 'index.json');

  let index = { ideas: [] };
  if (fs.existsSync(indexPath)) {
    index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  }

  const body = context.payload.issue.body || '';
  const name = getField(body, 'Your Name');
  const email = getField(body, 'Your Email');
  const ideaText = getField(body, 'Your Idea');

  if (!ideaText) {
    core.setFailed('Could not find idea text in the issue body — check the form field labels match.');
    return;
  }

  const newKeywords = extractKeywords(ideaText);

  // Compare against every stored idea, keep the closest match.
  let bestMatch = null;
  let bestScore = 0;
  for (const entry of index.ideas) {
    const score = jaccardSimilarity(newKeywords, entry.keywords);
    if (score > bestScore) {
      bestScore = score;
      bestMatch = entry;
    }
  }

  const isDuplicate = bestMatch && bestScore >= SIMILARITY_THRESHOLD;

  if (isDuplicate) {
    await github.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      body:
        `⚠️ This looks similar to an already-submitted idea in \`${bestMatch.file}\` ` +
        `(from issue #${bestMatch.issue_number}, similarity score ${bestScore.toFixed(2)}).\n\n` +
        `Please check that one before proceeding — if it's genuinely different, feel free to ` +
        `note why in a comment and a maintainer can re-review.`
    });
    await github.rest.issues.addLabels({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: context.issue.number,
      labels: ['possible-duplicate']
    });
    core.setOutput('added', 'false');
    return;
  }

  // No duplicate found — store it as a new idea.
  const nextId = index.ideas.length + 1;
  const paddedId = String(nextId).padStart(4, '0');
  const slug = slugify(ideaText) || 'idea';
  const fileName = `${paddedId}-${slug}.md`;
  const filePath = path.join('ideas', fileName);
  const submittedAt = new Date().toISOString();

  const fileContent = `---
id: ${nextId}
issue_number: ${context.issue.number}
name: "${name.replace(/"/g, '\\"')}"
email: "${email.replace(/"/g, '\\"')}"
submitted_at: "${submittedAt}"
keywords: [${newKeywords.map((k) => `"${k}"`).join(', ')}]
---

## Idea

${ideaText}
`;

  fs.mkdirSync('ideas', { recursive: true });
  fs.writeFileSync(filePath, fileContent);

  index.ideas.push({
    id: nextId,
    issue_number: context.issue.number,
    file: filePath,
    name,
    email,
    keywords: newKeywords,
    submitted_at: submittedAt
  });
  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));

  core.setOutput('added', 'true');
  core.setOutput('file_path', filePath);

  await github.rest.issues.createComment({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    body: `✅ New idea recorded at \`${filePath}\`. Thanks for the submission${name ? `, ${name}` : ''}!`
  });
  await github.rest.issues.addLabels({
    owner: context.repo.owner,
    repo: context.repo.repo,
    issue_number: context.issue.number,
    labels: ['accepted']
  });
};
