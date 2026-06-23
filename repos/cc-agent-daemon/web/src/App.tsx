import { Routes, Route } from "react-router-dom";
import { DaemonProvider, useDaemon } from "./context/DaemonContext";
import { ChatNotifyProvider } from "./context/ChatNotifyContext";
import { ThemeProvider } from "./context/ThemeContext";
import { HomePage } from "./pages/HomePage";
import { ChatPage } from "./pages/ChatPage";
import { LoginPage } from "./pages/LoginPage";
import type { ReactNode } from "react";

function Gate({ children }: { children: ReactNode }) {
  const { status } = useDaemon();
  if (status === "connected") return <>{children}</>;
  if (status === "connecting") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-zinc-50 text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-300 border-t-violet-500 dark:border-zinc-700 dark:border-t-violet-400" />
        <p className="text-sm">连接中…</p>
      </div>
    );
  }
  return <LoginPage />;
}

export default function App() {
  return (
    <ThemeProvider>
      <DaemonProvider>
        <ChatNotifyProvider>
          <div className="h-full flex flex-col bg-zinc-50 text-zinc-950 dark:bg-zinc-950 dark:text-zinc-50">
            <Gate>
              <Routes>
                <Route path="/" element={<HomePage />} />
                <Route path="/chat/:workspacePath" element={<ChatPage />} />
                <Route path="/chat/:workspacePath/:sessionId" element={<ChatPage />} />
              </Routes>
            </Gate>
          </div>
        </ChatNotifyProvider>
      </DaemonProvider>
    </ThemeProvider>
  );
}
