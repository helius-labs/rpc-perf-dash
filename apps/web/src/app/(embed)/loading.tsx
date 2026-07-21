// Minimal loading state for embeds — a low-key placeholder while the server
// component streams. Kept short so the auto-resize doesn't flash a tall frame.
export default function EmbedLoading() {
  return (
    <div className="py-10 text-center font-geistmono text-[11px] text-muted">
      Loading live benchmark data…
    </div>
  );
}
