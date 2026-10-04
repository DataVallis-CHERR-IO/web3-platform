import { notFound } from "next/navigation";

// Unknown paths under a locale render the same not-found page as a hidden
// admin page (TASK-035): one 404, same layout, same text.
export default function CatchAll() {
  notFound();
}
