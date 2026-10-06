// scripts/generate-embeddings.js
//
// ONE-TIME MIGRATION
//
// Reads ideas/index.json and generates Gemini embeddings
// for existing ideas that don't have one yet.
//
// Run from the repository root:
//
//   node scripts/generate-embeddings.js
//
// Requires:
//
//   GEMINI_API_KEY
//

const fs = require('fs');
const path = require('path');

const EMBEDDING_MODEL =
  'gemini-embedding-2';

const INDEX_PATH =
  path.join(
    'ideas',
    'index.json'
  );

// ============================================================
// Gemini embedding
// ============================================================

async function generateEmbedding(text) {

  const apiKey =
    process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error(
      'GEMINI_API_KEY environment variable is missing.'
    );
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent`;

  const response =
    await fetch(
      url,
      {
        method: 'POST',

        headers: {
          'Content-Type':
            'application/json',

          'x-goog-api-key':
            apiKey
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
      }
    );

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
      'No embedding returned from Gemini.'
    );
  }

  return data.embedding.values;
}

// ============================================================
// Main
// ============================================================

async function main() {

  if (
    !fs.existsSync(
      INDEX_PATH
    )
  ) {

    throw new Error(
      `Could not find ${INDEX_PATH}`
    );
  }

  const index =
    JSON.parse(
      fs.readFileSync(
        INDEX_PATH,
        'utf8'
      )
    );

  if (
    !Array.isArray(
      index.ideas
    )
  ) {

    throw new Error(
      'index.json does not contain an ideas array.'
    );
  }

  console.log(
    `Found ${index.ideas.length} ideas.`
  );

  let generated = 0;

  let skipped = 0;

  for (
    const idea of index.ideas
  ) {

    // Don't regenerate existing embeddings.
    if (
      Array.isArray(
        idea.embedding
      ) &&
      idea.embedding.length > 0
    ) {

      console.log(
        `Skipping idea #${idea.id} - embedding already exists.`
      );

      skipped++;

      continue;
    }

    // Build semantic text.
    const semanticText = `
Idea Title:
${idea.title || ''}

Problem:
${idea.problem || ''}

Proposed Solution:
${idea.solution || idea.idea_text || ''}

Expected Benefit:
${idea.benefit || ''}

Who Would Benefit:
${idea.users || ''}

Category:
${idea.category || ''}

Original idea:
${idea.idea_text || ''}
`.trim();

    console.log(
      `Generating embedding for idea #${idea.id}...`
    );

    try {

      idea.embedding =
        await generateEmbedding(
          semanticText
        );

      generated++;

      console.log(
        `✓ Idea #${idea.id} completed.`
      );

      // Save after EVERY idea.
      //
      // This means if the script stops halfway,
      // you can simply run it again.
      fs.writeFileSync(
        INDEX_PATH,
        JSON.stringify(
          index,
          null,
          2
        )
      );

    } catch (error) {

      console.error(
        `✗ Failed for idea #${idea.id}:`,
        error.message
      );

      console.error(
        'Stopping migration.'
      );

      process.exit(1);
    }
  }

  console.log('');
  console.log(
    '===================================='
  );

  console.log(
    'Embedding migration complete!'
  );

  console.log(
    `Generated: ${generated}`
  );

  console.log(
    `Skipped:   ${skipped}`
  );

  console.log(
    '===================================='
  );
}

main().catch(
  (error) => {

    console.error(
      error
    );

    process.exit(1);
  }
);
