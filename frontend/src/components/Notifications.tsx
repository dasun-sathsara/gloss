import { useEffect, useRef } from "react";
import { Toaster, toast } from "sonner";
import type { Preferences } from "../lib";

export function Notifications({
  notice,
  error,
  inlineError,
  theme,
}: {
  notice: string;
  error: string;
  inlineError: boolean;
  theme: Preferences["theme"];
}) {
  const previous = useRef({ notice: "", error: "" });

  useEffect(() => {
    const { notice: oldNotice, error: oldError } = previous.current;
    previous.current = { notice, error };
    // A new error replaces any earlier success message. Dialogs own their own errors.
    if (error && error !== oldError) {
      if (inlineError) toast.dismiss("gloss-feedback");
      else toast.error(error, { id: "gloss-feedback", duration: 6500 });
    } else if (!error && notice && notice !== oldNotice) {
      toast(notice, { id: "gloss-feedback" });
    } else if (!error && !notice) {
      toast.dismiss("gloss-feedback");
    }
  }, [error, inlineError, notice]);

  return <Toaster theme={theme} closeButton position="bottom-right" offset={24} />;
}
