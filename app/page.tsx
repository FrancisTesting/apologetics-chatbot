"use client";
import { useEffect, useRef, useState } from "react";

type ChatMessage = {
  role: "user" | "bot";
  content: string;
};

export default function Home() {
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [style, setStyle] = useState<"short" | "medium" | "detailed">("medium");
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, isLoading]);

  const sendMessage = async () => {
    if (!input.trim() || isLoading) return;
    const userText = input.trim();
    const nextMessages: ChatMessage[] = [
      ...messages,
      { role: "user", content: userText },
    ];
    setMessages(nextMessages);
    setInput("");
    setIsLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userText,
          history: messages.slice(-8),
          style,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data?.error || "Failed to get response from server");
      }

      setMessages([...nextMessages, { role: "bot", content: data.reply }]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected error";
      setMessages([...nextMessages, { role: "bot", content: message }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="chat-page">
      <section className="chat-card">
        <header className="chat-header">
          <div className="wa-avatar">A</div>
          <div>
            <h1>GA GPT Chatbot</h1>
            <p>online</p>
          </div>
        </header>

        <div ref={listRef} className="chat-list">
          {messages.length === 0 && (
            <div className="empty-state">
              Ask a question from your uploaded theology documents.
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`bubble ${m.role === "user" ? "user" : "bot"}`}>
              <div className="bubble-role">
                {m.role === "user" ? "You" : "Glory Apologetics"}
              </div>
              <div className="bubble-text">{m.content}</div>
            </div>
          ))}

          {isLoading && (
            <div className="bubble bot">
              <div className="bubble-role">Glory Apologetics</div>
              <div className="typing">Thinking...</div>
            </div>
          )}
        </div>

        <div className="chat-input-row">
          <select
            value={style}
            onChange={(e) => setStyle(e.target.value as "short" | "medium" | "detailed")}
          >
            <option value="short">Short</option>
            <option value="medium">Medium</option>
            <option value="detailed">Detailed</option>
          </select>
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask anything about faith, Bible, and apologetics..."
            onKeyDown={(e) => {
              if (e.key === "Enter") sendMessage();
            }}
          />
          <button onClick={sendMessage} disabled={isLoading || !input.trim()}>
            {isLoading ? "..." : "Send"}
          </button>
        </div>
      </section>
    </main>
  );
}

