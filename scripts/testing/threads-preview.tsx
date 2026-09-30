import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setEmailGateDone } from "../../src/lib/email-gate";
import { applySkin, readSkin } from "../../src/lib/skins";
import "../../src/styles.css";

// This entry point is served only by the disposable verification launcher.
if (!new URLSearchParams(location.search).has("onboarding")) setEmailGateDone("skipped");
applySkin(readSkin());
createRoot(document.getElementById("root")!).render(<App />);
