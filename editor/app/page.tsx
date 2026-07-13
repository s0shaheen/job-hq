import Editor from "../components/Editor";
import { repoConfig } from "../lib/github";

// Env is read per-request, not baked at build (Vercel env edits apply on the fly).
export const dynamic = "force-dynamic";

export default function Page() {
  const { repo, branch } = repoConfig();
  return <Editor repo={repo} branch={branch} driveFolderUrl={process.env.DRIVE_FOLDER_URL || null} />;
}
