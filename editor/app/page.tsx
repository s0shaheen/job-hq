import Editor from "../components/Editor";
import { repoConfig } from "../lib/github";

// Env is read per-request, not baked at build (Vercel env edits apply on the fly).
export const dynamic = "force-dynamic";

export default function Page() {
  const { repo, branch } = repoConfig();
  // Optional post-render link. Deliberately generic: WHERE a deployment's
  // render workflow puts the PDF (Drive, S3, an artifact page, nowhere) is that
  // deployment's business, so both the URL and its label are configuration.
  return (
    <Editor
      repo={repo}
      branch={branch}
      publishLinkUrl={process.env.PUBLISH_LINK_URL || null}
      publishLinkLabel={process.env.PUBLISH_LINK_LABEL || "Open output folder"}
    />
  );
}
