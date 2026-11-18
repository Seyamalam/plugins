import { useEffect, useState } from "react";
import { ChatView } from "./ChatView";
import { currentPageLocation, useContextTab } from "./pageLocation";
import { History } from "./History";
import { RuntimeStopped } from "./Notices";
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

function NewChat() {
  const session = useSession();
  const [chatId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (session.api) void session.api.open(`${chatId}${currentPageLocation().search}`).catch(() => undefined);
  }, [session.api]);
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
  const here = currentPageLocation();
  const route = routeOf(here.path);
  const contextTab = useContextTab();
  if (session.error && session.connected === false) return <RuntimeStopped />;
  if (route.kind === "history") return <History />;
  if (route.kind === "welcome") return <Welcome />;
  if (route.kind === "new") return <NewChat />;
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
