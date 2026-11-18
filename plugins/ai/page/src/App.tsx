import { useEffect, useState } from "react";
import { ChatView } from "./ChatView";
import { currentPageLocation, isStaticPage, replacePagePath, useContextTab } from "./pageLocation";
import { History } from "./History";
import { Centered, RuntimeStopped } from "./Notices";
import type { ContextTab } from "./Composer";
import { SessionProvider, useSession } from "./session";
import { Welcome } from "./Welcome";
import { watchGlass } from "./glass";

export type Route = { kind: "chat"; chatId: string } | { kind: "new" } | { kind: "history" } | { kind: "welcome" };

const CHAT_ID = /^[A-Za-z0-9-]{8,64}$/;

export function routeOf(pathname: string): Route {
  const path = pathname.replace(/^\/+|\/+$/g, "");
  if (path === "history") return { kind: "history" };
  if (path === "welcome") return { kind: "welcome" };
  if (CHAT_ID.test(path) && path !== "history") return { kind: "chat", chatId: path };
  return { kind: "new" };
}

function NewChat({ search, contextTab }: { search: string; contextTab: ContextTab | null }) {
  const session = useSession();
  const [chatId] = useState(() => crypto.randomUUID());
  const [failed, setFailed] = useState<string | null>(null);
  const inPlace = isStaticPage();
  useEffect(() => {
    if (inPlace) return replacePagePath(`/${chatId}`);
    if (session.api) void session.api.open(`${chatId}${search}`).catch((error: unknown) => setFailed(error instanceof Error ? error.message : String(error)));
  }, [session.api]);
  if (inPlace) return <ChatView chatId={chatId} contextTab={contextTab} initialPrompt={new URLSearchParams(search).get("q")} />;
  if (failed) return <Centered testId="open-failed" title="This chat couldn't open" detail={failed} />;
  return null;
}

function useLinksThroughHelper() {
  const session = useSession();
  useEffect(() => {
    const open = session.openUrl;
    if (!open) return;
    const onClick = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!link || !/^https?:/i.test(link.href)) return;
      event.preventDefault();
      open(link.href);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [session.openUrl]);
}

function Screen() {
  const session = useSession();
  useLinksThroughHelper();
  const [here] = useState(currentPageLocation);
  const route = routeOf(here.path);
  const contextTab = useContextTab();
  if (session.screen.kind === "reconnecting") return <RuntimeStopped />;
  if (route.kind === "history") return <History />;
  if (route.kind === "welcome") return <Welcome />;
  if (route.kind === "new") return <NewChat search={here.search} contextTab={contextTab} />;
  const query = new URLSearchParams(here.search);
  return <ChatView chatId={route.chatId} contextTab={contextTab} initialPrompt={query.get("q")} />;
}

export function App() {
  useEffect(() => watchGlass(), []);
  return (
    <SessionProvider>
      <div className="app">
        <Screen />
      </div>
    </SessionProvider>
  );
}
