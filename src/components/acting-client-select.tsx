"use client";

// Epic #250 S7 — the admin's "act as this client" selector on the client
// gallery preview. It is NOT `client-picker.tsx` (that one attaches/creates
// clients on a gallery, task #247); this one picks the SUBJECT of the visit,
// which is what the PATCH route's `actingClientId` must name (decision 12).
//
// The URL is the state. Changing the selection replaces `?viewAs=<id>`, and
// the page remounts `<ProofGrid>` with `key={viewAsId ?? "self"}` so the
// hook's state initialisers re-run for the new person. There is deliberately
// no local `useState` here: two sources of truth for "who am I acting as"
// is exactly how a grid ends up writing for one person while showing another.
import { usePathname, useRouter } from "next/navigation";

export type ActingClientOption = {
  id: string;
  /** `users.name ?? users.email`, resolved by the page. */
  label: string;
};

export function ActingClientSelect({
  members,
  value,
}: {
  /** The gallery's ACTIVE clients, in the server's order. */
  members: ActingClientOption[];
  /** The currently viewed subject, or `null` for "Nadie (solo mirar)". */
  value: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();

  return (
    <label className="text-fg-mute flex shrink-0 items-center gap-2 text-sm">
      Actuar como
      <select
        value={value ?? ""}
        onChange={(event) => {
          const id = event.target.value;
          router.replace(pathname + (id ? `?viewAs=${encodeURIComponent(id)}` : ""));
        }}
        className="border-line-2 bg-bg text-fg focus-visible:ring-accent min-h-9 rounded-sm border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
      >
        <option value="">Nadie (solo mirar)</option>
        {members.map((member) => (
          <option key={member.id} value={member.id}>
            {member.label}
          </option>
        ))}
      </select>
    </label>
  );
}
