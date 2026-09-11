// A view the agent named ("VIEW FROM A"), as a pill. Click: the studio opens
// that sheet and frames that view — the other half of "same name both
// ways": you point at a view for the agent, the agent points at one for you.
import { canShow, showView, useViewing } from "@/lib/viewingLive";

export function ViewPill({
  token,
  children,
}: {
  token: string;
  children?: React.ReactNode;
}) {
  const viewing = useViewing();
  const v = viewing?.views?.find((x) => x.key === token);
  const label = v ? v.caption : token;
  const live = !!(canShow(viewing) && v);   // a piece by mark, or the Elements tab's element by id
  return (
    <button
      type="button"
      className="mention"
      title={
        live
          ? `${label}${v?.denom ? ` · 1:${v.denom}` : ""} — click to frame it on the sheet`
          : label
      }
      onClick={() => (live ? showView(token, viewing) : undefined)}
      disabled={!live}
    >
      {children ?? label}
    </button>
  );
}
