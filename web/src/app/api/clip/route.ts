import { NextRequest } from "next/server";
import fs from "node:fs";
import path from "node:path";
import { careerOpsRoot } from "@/lib/career-ops";
import { addOffersToPipeline } from "@/lib/core/pipeline";
import { parseInbox } from "@/lib/pipeline-table.mjs";
import { parseApplications } from "@/lib/tracker-table.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Requested-With",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders });
}

export async function GET() {
  const root = careerOpsRoot();
  const pipelinePath = path.join(root, "data", "pipeline.md");
  const appsPath = path.join(root, "data", "applications.md");

  let pendingCount = 0;
  let appCount = 0;

  try {
    if (fs.existsSync(pipelinePath)) {
      pendingCount = parseInbox(fs.readFileSync(pipelinePath, "utf8")).length;
    }
    if (fs.existsSync(appsPath)) {
      appCount = parseApplications(fs.readFileSync(appsPath, "utf8")).length;
    }
  } catch {
    // fallback
  }

  return Response.json(
    {
      ok: true,
      service: "career-ops-web",
      version: "1.0.0",
      root,
      counts: {
        pending: pendingCount,
        applications: appCount,
      },
    },
    { headers: corsHeaders }
  );
}

function captureSlug(text: string): string {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const url = String(body.url || "").trim();
    const company = String(body.company || "").trim();
    const title = String(body.title || "").trim();
    const location = String(body.location || "").trim();
    const compensation = String(body.compensation || body.salary || "").trim();
    const description = String(body.description || "").trim();
    const source = String(body.source || "extension").trim();
    const saveJd = body.saveJd !== false;

    if (!url || !company || !title) {
      return Response.json(
        { ok: false, error: "Missing required fields: url, company, title" },
        { status: 400, headers: corsHeaders }
      );
    }

    const offer = {
      url,
      company,
      title,
      location,
      source,
      note: compensation ? `comp: ${compensation}` : "",
    };

    const result = await addOffersToPipeline([offer]);

    if (result.error) {
      return Response.json(
        { ok: false, error: result.error },
        { status: 500, headers: corsHeaders }
      );
    }

    // Save JD file if description provided
    let jdFile: string | null = null;
    const root = careerOpsRoot();
    const jdsDir = path.join(root, "jds");

    if (saveJd && description) {
      if (!fs.existsSync(jdsDir)) {
        fs.mkdirSync(jdsDir, { recursive: true });
      }

      const today = new Date().toISOString().slice(0, 10);
      const companySlug = captureSlug(company) || "company";
      const roleSlug = captureSlug(title) || "role";
      const baseName = `${today}_${companySlug}_${roleSlug}`;
      let fileName = `${baseName}.md`;
      let targetPath = path.join(jdsDir, fileName);

      let counter = 1;
      while (fs.existsSync(targetPath)) {
        counter++;
        fileName = `${baseName}-${counter}.md`;
        targetPath = path.join(jdsDir, fileName);
      }

      const jdContent = `# ${title} — ${company}

- **URL:** ${url}
- **Company:** ${company}
- **Role:** ${title}
- **Location:** ${location || "Not specified"}
- **Compensation:** ${compensation || "Not specified"}
- **Source:** ${source || "extension"}
- **Captured:** ${today}

---

## Job Description

${description.trim()}
`;

      fs.writeFileSync(targetPath, jdContent, "utf8");
      jdFile = path.relative(root, targetPath);
    }

    const expectedRow = `- [ ] ${url} | ${company} | ${title}${location ? ` | ${location}` : ""}`;

    return Response.json(
      {
        ok: true,
        status: result.added > 0 ? "added" : "duplicate",
        message: result.added > 0 ? "Successfully added to pipeline" : "Posting was already in pipeline",
        row: expectedRow,
        jdFile,
      },
      { headers: corsHeaders }
    );
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err.message || "Failed to clip posting" },
      { status: 500, headers: corsHeaders }
    );
  }
}
