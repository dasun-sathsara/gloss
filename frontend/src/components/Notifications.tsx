import { useEffect, useRef } from "react";
import { Toaster, toast } from "sonner";
import type { Preferences } from "../lib";

export function Notifications({
  notice,
  error,
  inlineError,
  theme,
}: {
  notice: { message: string } | null;
  error: string;
  inlineError: boolean;
  theme: Preferences["theme"];
}) {
  const previous = useRef<{ notice: typeof notice; error: string }>({ notice: null, error: "" });
  const activeToast = useRef<string | number | null>(null);

  useEffect(() => {
    const { notice: oldNotice, error: oldError } = previous.current;
    previous.current = { notice, error };
    const dismissPrevious = () => {
      if (activeToast.current !== null) toast.dismiss(activeToast.current);
      activeToast.current = null;
    };
    // Each notification gets a new ID so an older toast's exit cannot remove it.
    if (error && error !== oldError) {
      dismissPrevious();
      if (!inlineError) activeToast.current = toast.error(error, { duration: 6500 });
    } else if (!error && notice && notice !== oldNotice) {
      dismissPrevious();
      activeToast.current = toast(notice.message);
    } else if (!error && !notice) {
      dismissPrevious();
    }
  }, [error, inlineError, notice]);

  return <Toaster theme={theme} closeButton position="bottom-right" offset={24} />;
}
