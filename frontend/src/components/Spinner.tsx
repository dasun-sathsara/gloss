export function Spinner({ className }: { className?: string }) {
  return <span className={className ? `spinner ${className}` : "spinner"} aria-hidden="true" />;
}
