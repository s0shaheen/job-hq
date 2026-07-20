import { redirect } from "next/navigation";

/** The queue is home. */
export default function Home() {
  redirect("/queue");
}
