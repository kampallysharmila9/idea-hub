// scripts/process-idea.js
//
// Idea processing:
//
// 1. Read GitHub Issue Form
// 2. Build semantic representation
// 3. Generate Gemini embedding
// 4. Compare against existing idea embeddings
// 5. Calculate cosine similarity
// 6. Calculate Jaccard similarity
// 7. Decide NEW / POSSIBLE DUPLICATE / DUPLICATE
// 8. Store new idea and embedding
//

const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURATION
// ============================================================

const EMBEDDING_MODEL = 'gemini-embedding-2';

const DUPLICATE_THRESHOLD = 0.90;
const POSSIBLE_DUPLICATE_THRESHOLD = 0.75;

// ============================================================
// STOPWORDS
// ============================================================

const STOPWORDS = new Set([
  'this',
  'that',
  'with',
  'from',
  'have',
  'will',
  'would',
  'should',
  'about',
  'which',
  'there',
  'their',
  'into',
  'also',
  'when',
  'where',
  'what',
  'while',
  'your',
  'than',
  'them',
  'they',
  'been',
  'were',
  'being',
  'could',
  'very',
  'more',
  'some',
  'want',
  'like',
  'idea',
  'users',
  'user'
]);

// ============================================================
// KEYWORD EXTRACTION
// ============================================================

function extractKeywords(text) {
  return [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(
          (word) =>
            word.length >= 4 &&
            !STOPWORDS.has(word)
        )
    )
  ];
}

// ============================================================
// JACCARD SIMILARITY
// ============================================================

function jaccardSimilarity(a, b) {
  const setA = new Set(a || []);
  const setB = new Set(b || []);

  if (setA.size === 0 || setB.size === 0) {
    return 0;
  }

  const intersection = [...setA].filter(
    (word) => setB.has(word)
  ).length;

  const union = new Set([
    ...setA,
    ...setB
  ]).size;

  return intersection / union;
}

// ============================================================
// COSINE SIMILARITY
// ============================================================

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) {
    return 0;
  }

  if (a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];

    magnitudeA += a[i] * a[i];

    magnitudeB += b[i] * b[i];
  }

  if (magnitudeA === 0 || magnitudeB === 0) {
    return 0;
  }

  return (
    dotProduct /
    (
      Math.sqrt(magnitudeA) *
      Math.sqrt(magnitudeB)
    )
  );
}

// ============================================================
// ISSUE FORM PARSER
// ============================================================

function getField(body, label) {
  const escapedLabel =
    label.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

  const regex = new RegExp(
    `### ${escapedLabel}\\s*\\n+([\\s\\S]*?)(?=\\n###|$)`,
    'i'
  );

  const match = body.match(regex);

  return match
    ? match[1].trim()
    : '';
}

// ============================================================
// SLUGIFY
// ============================================================

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 8)
    .join('-');
}

// ============================================================
// GEMINI EMBEDDING
// ============================================================

async function generateEmbedding(text) {
  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY is missing. ' +
      'Add it under GitHub Settings → Secrets → Actions.'
    );
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;

  const response =
    await fetch(url, {
      method: 'POST',

      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey
      },

      body: JSON.stringify({
        model:
          `models/${EMBEDDING_MODEL}`,

        content: {
          parts: [
            {
              text
            }
          ]
        },

        output_dimensionality: 768
      })
    });

  if (!response.ok) {
    const error =
      await response.text();

    throw new Error(
      `Gemini API error ${response.status}: ${error}`
    );
  }

  const data =
    await response.json();

  if (
    !data.embedding ||
    !data.embedding.values
  ) {
    throw new Error(
      'Gemini returned no embedding.'
    );
  }

  return data.embedding.values;
}

// ============================================================
// CREATE DUPLICATE COMMENT
// ============================================================

async function createDuplicateComment(
  github,
  context,
  match,
  semanticScore,
  keywordScore
) {
  const semanticPercentage =
    (semanticScore * 100).toFixed(1);

  const keywordPercentage =
    (keywordScore * 100).toFixed(1);

  await github.rest.issues.createComment({
    owner: context.repo.owner,

    repo: context.repo.repo,

    issue_number: context.issue.number,

    body:
      `## 🔴 Possible Duplicate\n\n` +

      `Your idea appears very similar to an ` +
      `existing idea.\n\n` +

      `### Existing idea\n\n` +

      `**${match.title || match.file}**\n\n` +

      `Issue: #${match.issue_number}\n\n` +

      `File: \`${match.file}\`\n\n` +

      `### Similarity\n\n` +

      `- Semantic similarity: **${semanticPercentage}%**\n` +
      `- Keyword similarity: **${keywordPercentage}%**\n\n` +

      `Please review the existing idea before submitting ` +
      `a duplicate.\n\n` +

      `If you believe this is genuinely different, explain ` +
      `the difference in a comment so a maintainer can review it.`
  });

  await github.rest.issues.addLabels({
    owner: context.repo.owner,

    repo: context.repo.repo,

    issue_number: context.issue.number,

    labels: [
      'possible-duplicate'
    ]
  });
}

// ============================================================
// CREATE POSSIBLE DUPLICATE COMMENT
// ============================================================

async function createPossibleDuplicateComment(
  github,
  context,
  match,
  semanticScore,
  keywordScore
) {
  await github.rest.issues.createComment({
    owner: context.repo.owner,

    repo: context.repo.repo,

    issue_number: context.issue.number,

    body:
      `## 🟡 Similar Idea Found\n\n` +

      `Your idea appears related to an existing idea, ` +
      `but it is not being automatically rejected.\n\n` +

      `Existing idea:\n` +

      `**${match.title || match.file}**\n\n` +

      `Issue: #${match.issue_number}\n\n` +

      `Semantic similarity: **${(semanticScore * 100).toFixed(1)}%**\n\n` +

      `Keyword similarity: **${(keywordScore * 100).toFixed(1)}%**\n\n` +

      `Please review the existing idea and explain why ` +
      `your proposal is different if appropriate.`
  });

  await github.rest.issues.addLabels({
    owner: context.repo.owner,

    repo: context.repo.repo,

    issue_number: context.issue.number,

    labels: [
      'possible-duplicate'
    ]
  });
}

// ============================================================
// MAIN FUNCTION
// ============================================================

module.exports = async ({
  github,
  context,
  core
}) => {

  const indexPath =
    path.join(
      'ideas',
      'index.json'
    );

  // ----------------------------------------------------------
  // Load index
  // ----------------------------------------------------------

  let index = {
    ideas: []
  };

  if (
    fs.existsSync(indexPath)
  ) {
    index =
      JSON.parse(
        fs.readFileSync(
          indexPath,
          'utf8'
        )
      );
  }

  // ----------------------------------------------------------
  // Read issue
  // ----------------------------------------------------------

  const body =
    context.payload.issue.body || '';

  const name =
    getField(
      body,
      'Your Name'
    );

  const title =
    getField(
      body,
      'Idea Title'
    );

  const problem =
    getField(
      body,
      'Problem / Pain Point'
    );

  const solution =
    getField(
      body,
      'Proposed Solution'
    );

  const benefit =
    getField(
      body,
      'Expected Benefit'
    );

  const users =
    getField(
      body,
      'Who Would Benefit?'
    );

  const category =
    getField(
      body,
      'Category'
    );

  const additional =
    getField(
      body,
      'Additional Details'
    );

  // ----------------------------------------------------------
  // Validate required fields
  // ----------------------------------------------------------

  if (!name) {
    core.setFailed(
      'Your Name was not found.'
    );
    return;
  }

  if (!title) {
    core.setFailed(
      'Idea Title was not found.'
    );
    return;
  }

  if (!problem) {
    core.setFailed(
      'Problem / Pain Point was not found.'
    );
    return;
  }

  if (!solution) {
    core.setFailed(
      'Proposed Solution was not found.'
    );
    return;
  }

  if (!benefit) {
    core.setFailed(
      'Expected Benefit was not found.'
    );
    return;
  }

  if (!users) {
    core.setFailed(
      'Who Would Benefit was not found.'
    );
    return;
  }

  if (!category) {
    core.setFailed(
      'Category was not found.'
    );
    return;
  }

  // ----------------------------------------------------------
  // Build semantic text
  // ----------------------------------------------------------

  const semanticText = `
Idea Title:
${title}

Problem:
${problem}

Proposed Solution:
${solution}

Expected Benefit:
${benefit}

Who Would Benefit:
${users}

Category:
${category}

Additional Details:
${additional}
`.trim();

  console.log(
    'Semantic text prepared.'
  );

  // ----------------------------------------------------------
  // Keywords
  // ----------------------------------------------------------

  const newKeywords =
    extractKeywords(
      semanticText
    );

  console.log(
    `Extracted ${newKeywords.length} keywords.`
  );

  // ----------------------------------------------------------
  // Generate embedding
  // ----------------------------------------------------------

  let embedding;

  try {

    console.log(
      'Generating Gemini embedding...'
    );

    embedding =
      await generateEmbedding(
        semanticText
      );

    console.log(
      `Embedding generated: ${embedding.length} dimensions.`
    );

  } catch (error) {

    console.error(
      error.message
    );

    core.setFailed(
      `Could not generate embedding: ${error.message}`
    );

    return;
  }

  // ----------------------------------------------------------
  // Find best match
  // ----------------------------------------------------------

  let bestMatch = null;

  let bestSemanticScore = 0;

  let bestKeywordScore = 0;

  for (
    const entry of index.ideas
  ) {

    // Old ideas may not have embeddings.
    if (
      !Array.isArray(
        entry.embedding
      )
    ) {
      continue;
    }

    const semanticScore =
      cosineSimilarity(
        embedding,
        entry.embedding
      );

    const keywordScore =
      jaccardSimilarity(
        newKeywords,
        entry.keywords || []
      );

    console.log(
      `Idea #${entry.id}: ` +
      `semantic=${semanticScore.toFixed(4)}, ` +
      `keywords=${keywordScore.toFixed(4)}`
    );

    if (
      semanticScore >
      bestSemanticScore
    ) {

      bestSemanticScore =
        semanticScore;

      bestKeywordScore =
        keywordScore;

      bestMatch =
        entry;
    }
  }

  // ----------------------------------------------------------
  // Print best match
  // ----------------------------------------------------------

  if (bestMatch) {

    console.log(
      '===================================='
    );

    console.log(
      'BEST MATCH'
    );

    console.log(
      `Idea: #${bestMatch.id}`
    );

    console.log(
      `File: ${bestMatch.file}`
    );

    console.log(
      `Semantic similarity: ${bestSemanticScore.toFixed(4)}`
    );

    console.log(
      `Keyword similarity: ${bestKeywordScore.toFixed(4)}`
    );

    console.log(
      '===================================='
    );
  } else {

    console.log(
      'No existing ideas with embeddings found.'
    );
  }

  // ----------------------------------------------------------
  // Strong duplicate
  // ----------------------------------------------------------

  if (
    bestMatch &&
    bestSemanticScore >=
      DUPLICATE_THRESHOLD
  ) {

    console.log(
      'Possible duplicate detected.'
    );

    await createDuplicateComment(
      github,
      context,
      bestMatch,
      bestSemanticScore,
      bestKeywordScore
    );

    core.setOutput(
      'added',
      'false'
    );

    return;
  }

  // ----------------------------------------------------------
  // Possible duplicate
  // ----------------------------------------------------------

  if (
    bestMatch &&
    bestSemanticScore >=
      POSSIBLE_DUPLICATE_THRESHOLD
  ) {

    console.log(
      'Related / possible duplicate detected.'
    );

    await createPossibleDuplicateComment(
      github,
      context,
      bestMatch,
      bestSemanticScore,
      bestKeywordScore
    );

    // IMPORTANT:
    // We still store the idea.
  }

  // ----------------------------------------------------------
  // Store new idea
  // ----------------------------------------------------------

  const nextId =
    index.ideas.length === 0
      ? 1
      : Math.max(
          ...index.ideas.map(
            (idea) =>
              Number(idea.id) || 0
          )
        ) + 1;

  const paddedId =
    String(nextId)
      .padStart(4, '0');

  const slug =
    slugify(title) ||
    'idea';

  const fileName =
    `${paddedId}-${slug}.md`;

  const filePath =
    path.join(
      'ideas',
      fileName
    );

  const submittedAt =
    new Date().toISOString();

  // ----------------------------------------------------------
  // Markdown file
  // ----------------------------------------------------------

  const fileContent = `---
id: ${nextId}
issue_number: ${context.issue.number}
name: "${name.replace(/"/g, '\\"')}"
title: "${title.replace(/"/g, '\\"')}"
category: "${category.replace(/"/g, '\\"')}"
submitted_at: "${submittedAt}"
keywords: [${newKeywords
    .map(
      (keyword) =>
        `"${keyword.replace(/"/g, '\\"')}"`
    )
    .join(', ')}]
---

# ${title}

## Problem / Pain Point

${problem}

## Proposed Solution

${solution}

## Expected Benefit

${benefit}

## Who Would Benefit?

${users}

## Category

${category}

## Additional Details

${additional || 'None provided.'}

## Original Issue

#${context.issue.number}
`;

  fs.mkdirSync(
    'ideas',
    {
      recursive: true
    }
  );

  fs.writeFileSync(
    filePath,
    fileContent
  );

  // ----------------------------------------------------------
  // Add to index
  // ----------------------------------------------------------

  index.ideas.push({

    id: nextId,

    issue_number:
      context.issue.number,

    file:
      filePath,

    name,

    title,

    category,

    problem,

    solution,

    benefit,

    users,

    keywords:
      newKeywords,

    embedding,

    submitted_at:
      submittedAt
  });

  fs.writeFileSync(
    indexPath,
    JSON.stringify(
      index,
      null,
      2
    )
  );

  // ----------------------------------------------------------
  // Outputs
  // ----------------------------------------------------------

  core.setOutput(
    'added',
    'true'
  );

  core.setOutput(
    'file_path',
    filePath
  );

  // ----------------------------------------------------------
  // GitHub comment
  // ----------------------------------------------------------

  await github.rest.issues.createComment({
    owner:
      context.repo.owner,

    repo:
      context.repo.repo,

    issue_number:
      context.issue.number,

    body:
      `## ✅ Idea Recorded\n\n` +

      `Thank you${name ? `, ${name}` : ''}!\n\n` +

      `Your idea has been stored at ` +
      `\`${filePath}\`.\n\n` +

      `**Category:** ${category}\n\n` +

      `Your idea has also been checked against ` +
      `existing submissions using semantic similarity.`
  });

  // ----------------------------------------------------------
  // Accepted label
  // ----------------------------------------------------------

  await github.rest.issues.addLabels({
    owner:
      context.repo.owner,

    repo:
      context.repo.repo,

    issue_number:
      context.issue.number,

    labels: [
      'accepted'
    ]
  });

  console.log(
    `Idea #${nextId} successfully stored.`
  );
};
