/**
 * Seed script: reads every document in /data, turns it into chunks,
 * embeds them and stores them in MongoDB Atlas.
 *
 *   npx tsx --env-file=.env.local scripts/seed.ts            -> real run
 *   npx tsx scripts/seed.ts --dry-run                        -> only print chunks, no DB, no embeddings
 *
 * Expected folder layout:  data/<orgId>/<theme>/<file>.(md|txt|csv|json|pdf)
 *   - <orgId>  -> which organization the document belongs to (used for filtering!)
 *   - <theme>  -> what it is about (returns, shipping, products...)
 *   - data/<orgId>/_org.json holds the organization's display name
 */
import fs from "node:fs/promises";
import path from "node:path";
import { Document } from "@langchain/core/documents";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { parse as parseCsv } from "csv-parse/sync";

const DATA_DIR = path.join(process.cwd(), "data");
const DRY_RUN = process.argv.includes("--dry-run");

const CHUNK_SIZE = 800; // characters
const CHUNK_OVERLAP = 120;

type ChunkMetadata = {
  orgId: string;
  orgName: string;
  theme: string;
  source: string; // path relative to /data, useful to cite sources in answers
  format: string;
  page?: number;
};

type OrgInfo = { orgId: string; name: string };

// ---------------------------------------------------------------------------
// 1. Read files into "raw" LangChain Documents (one per file, page, row or record)
// ---------------------------------------------------------------------------

/** Turns an object into readable lines: "key: value". Used for CSV rows and JSON records. */
function recordToText(record: Record<string, unknown>): string {
  return Object.entries(record)
    .filter(([, value]) => value !== null && value !== "")
    .map(([key, value]) => `${key}: ${Array.isArray(value) ? value.join(", ") : String(value)}`)
    .join("\n");
}

async function loadFile(filePath: string): Promise<{ docs: Document[]; splittable: boolean }> {
  const ext = path.extname(filePath).toLowerCase();

  switch (ext) {
    case ".md":
    case ".txt": {
      const text = await fs.readFile(filePath, "utf8");
      return { docs: [new Document({ pageContent: text })], splittable: true };
    }

    case ".pdf": {
      // PDFLoader returns one Document per page by default
      const pages = await new PDFLoader(filePath).load();
      const docs = pages.map(
        (p) => new Document({ pageContent: p.pageContent, metadata: { page: p.metadata.loc?.pageNumber } }),
      );
      return { docs, splittable: true };
    }

    case ".csv": {
      // One row = one chunk. A row is already a small, self-contained unit (a product, a FAQ entry).
      const rows = parseCsv(await fs.readFile(filePath, "utf8"), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
      return { docs: rows.map((row) => new Document({ pageContent: recordToText(row) })), splittable: false };
    }

    case ".json": {
      // Expected: an array of records. One record = one chunk.
      const data = JSON.parse(await fs.readFile(filePath, "utf8"));
      const records: Record<string, unknown>[] = Array.isArray(data) ? data : [data];
      return { docs: records.map((r) => new Document({ pageContent: recordToText(r) })), splittable: false };
    }

    default:
      console.warn(`  ⚠ Skipping unsupported file type: ${filePath}`);
      return { docs: [], splittable: false };
  }
}

// ---------------------------------------------------------------------------
// 2. Walk data/<orgId>/<theme>/<file>, split, and add metadata + context header
// ---------------------------------------------------------------------------

async function buildChunksForOrg(orgDir: string): Promise<Document<ChunkMetadata>[]> {
  const org: OrgInfo = JSON.parse(await fs.readFile(path.join(orgDir, "_org.json"), "utf8"));

  const markdownSplitter = RecursiveCharacterTextSplitter.fromLanguage("markdown", {
    chunkSize: CHUNK_SIZE,
    chunkOverlap: CHUNK_OVERLAP,
  });
  const textSplitter = new RecursiveCharacterTextSplitter({ chunkSize: CHUNK_SIZE, chunkOverlap: CHUNK_OVERLAP });

  const chunks: Document<ChunkMetadata>[] = [];
  const themeDirs = await fs.readdir(orgDir, { withFileTypes: true });

  for (const themeDir of themeDirs.filter((d) => d.isDirectory())) {
    const theme = themeDir.name;
    const files = await fs.readdir(path.join(orgDir, theme));

    for (const file of files) {
      const filePath = path.join(orgDir, theme, file);
      const format = path.extname(file).slice(1).toLowerCase();
      const { docs, splittable } = await loadFile(filePath);

      const splitter = format === "md" ? markdownSplitter : textSplitter;
      const pieces = splittable ? await splitter.splitDocuments(docs) : docs;

      for (const piece of pieces) {
        const metadata: ChunkMetadata = {
          orgId: org.orgId,
          orgName: org.name,
          theme,
          source: path.relative(DATA_DIR, filePath),
          format,
          ...(piece.metadata.page ? { page: piece.metadata.page } : {}),
        };

        // Context header: helps the embedding (and later the LLM) know what the chunk is about.
        // It is NOT what keeps organizations apart - the orgId filter does that.
        const header = `Organization: ${org.name} | Theme: ${theme} | Source: ${file}`;

        chunks.push(new Document({ pageContent: `${header}\n\n${piece.pageContent.trim()}`, metadata }));
      }
    }
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// 3. Main: build chunks, then (unless dry run) replace them in MongoDB
// ---------------------------------------------------------------------------

async function main() {
  const orgDirs = (await fs.readdir(DATA_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => path.join(DATA_DIR, d.name));

  const chunksByOrg = new Map<string, Document<ChunkMetadata>[]>();
  for (const orgDir of orgDirs) {
    const chunks = await buildChunksForOrg(orgDir);
    chunksByOrg.set(chunks[0]?.metadata.orgId ?? path.basename(orgDir), chunks);
    console.log(`📁 ${path.basename(orgDir)}: ${chunks.length} chunks`);
  }

  if (DRY_RUN) {
    for (const [orgId, chunks] of chunksByOrg) {
      console.log(`\n================ ${orgId} ================`);
      for (const c of chunks) {
        console.log(`\n--- ${c.metadata.source}${c.metadata.page ? ` (page ${c.metadata.page})` : ""} [${c.pageContent.length} chars]`);
        console.log(c.pageContent);
      }
    }
    console.log("\nDry run: nothing was written to the database.");
    return;
  }

  // Imported here (not at the top) so --dry-run works without a database or env variables.
  const { client } = await import("../lib/db");
  const { embeddings, vectorStore, chunksCollection, VECTOR_INDEX_NAME } = await import("../lib/vectorStore");

  try {
    for (const [orgId, chunks] of chunksByOrg) {
      // Idempotent: re-running the script replaces an org's chunks instead of duplicating them.
      const { deletedCount } = await chunksCollection.deleteMany({ orgId });
      console.log(`\n🧹 ${orgId}: removed ${deletedCount} old chunks`);

      console.log(`🧠 ${orgId}: embedding and inserting ${chunks.length} chunks...`);
      await vectorStore.addDocuments(chunks);
    }

    // Create the vector search index if it doesn't exist yet.
    // numDimensions is read from the model itself, so it can't be wrong.
    const existing = await chunksCollection.listSearchIndexes(VECTOR_INDEX_NAME).toArray();
    if (existing.length === 0) {
      const numDimensions = (await embeddings.embedQuery("dimension check")).length;
      await chunksCollection.createSearchIndex({
        name: VECTOR_INDEX_NAME,
        type: "vectorSearch",
        definition: {
          fields: [
            { type: "vector", path: "embedding", numDimensions, similarity: "cosine" },
            { type: "filter", path: "orgId" },
            { type: "filter", path: "theme" },
          ],
        },
      });
      console.log(`\n📐 Created index "${VECTOR_INDEX_NAME}" (${numDimensions} dims). It takes ~1 minute to build.`);
    } else {
      console.log(`\n📐 Index "${VECTOR_INDEX_NAME}" already exists (status: ${(existing[0] as { status?: string }).status ?? "unknown"}).`);
    }

    console.log("\n✅ Seed done.");
  } finally {
    await client.close(); // otherwise the script never exits
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
