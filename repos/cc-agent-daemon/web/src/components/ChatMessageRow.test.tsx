import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ChatMessageRow } from "./ChatMessageRow";
import { MessageMarkdown } from "./MessageMarkdown";
import { ToolUseCard } from "./ToolUseCard";
import { AssistantMessageBody } from "./AssistantMessageBody";
import type { ChatMessage } from "../lib/messageBlocks";

describe("ChatMessageRow", () => {
  it("renders assistant thinking as a foldable section and tool use as a collapsed card", () => {
    const message: ChatMessage = {
      id: "a1",
      role: "assistant",
      model: "claude-opus-4-7",
      metrics: { usage: { input: 12, output: 34, total: 46 }, elapsedSeconds: 3.5 },
      content: [
        { type: "thinking", thinking: "I should inspect the file." },
        { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "/tmp/example.ts" } },
        { type: "text", text: "Done." },
      ],
    };

    const html = renderToStaticMarkup(
      <ChatMessageRow
        message={message}
        toolResults={{ "tool-1": { status: "completed", content: "const x = 1;" } }}
      />,
    );

    expect(html).toContain("Thinking");
    expect(html).toContain("Read");
    expect(html).toContain("/tmp/example.ts");
    expect(html).toContain("claude-opus-4-7");
    expect(html).toContain("tokens in 12 / out 34 / total 46");
    expect(html).toContain("3.5s");
    expect(html).toContain("Done.");
  });

  it("renders user messages without assistant metadata", () => {
    const html = renderToStaticMarkup(
      <ChatMessageRow message={{ id: "u1", role: "user", content: "hello" }} />,
    );

    expect(html).toContain("hello");
    expect(html).not.toContain("tokens");
    expect(html).not.toContain("Thinking");
  });

  it("outer container has min-w-0 to prevent flex overflow", () => {
    const html = renderToStaticMarkup(
      <ChatMessageRow message={{ id: "u1", role: "user", content: "hello" }} />,
    );
    // The outermost div must carry min-w-0 so it can shrink inside flex
    expect(html).toMatch(/class="[^"]*min-w-0[^"]*"/);
  });

  it("assistant bubble has overflow-hidden and min-w-0 for narrow screen containment", () => {
    const message: ChatMessage = {
      id: "a2",
      role: "assistant",
      content: [{ type: "text", text: "Hello world" }],
    };
    const html = renderToStaticMarkup(<ChatMessageRow message={message} />);
    // The bubble wrapper div should have both min-w-0 and overflow-hidden (order may vary)
    expect(html).toMatch(/class="[^"]*min-w-0[^"]*overflow-hidden[^"]*/);
  });
});

describe("MessageMarkdown overflow classes", () => {
  it("wraps <pre> with overflow-x-auto to allow horizontal scroll on narrow screens", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown content={"```js\nconst x = 1;\n```"} />,
    );
    expect(html).toContain("overflow-x-auto");
  });

  it("wraps <table> with overflow-x-auto container for horizontal scroll", () => {
    const md = `
| Col A | Col B |
|-------|-------|
| val1  | val2  |
`;
    const html = renderToStaticMarkup(<MessageMarkdown content={md} />);
    // The wrapper div around table must have overflow-x-auto
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("<table");
  });

  it("wrapper div has min-w-0 and overflow-hidden to prevent prose from expanding beyond container", () => {
    const html = renderToStaticMarkup(
      <MessageMarkdown content="Some text with a [link](https://example.com)." />,
    );
    // The prose wrapper div should have both min-w-0 and overflow-hidden
    expect(html).toMatch(/class="[^"]*min-w-0[^"]*overflow-hidden[^"]*/);
  });
});

describe("ToolUseCard overflow classes", () => {
  it("root element has min-w-0 and overflow-hidden to prevent card from expanding layout", () => {
    const html = renderToStaticMarkup(
      <ToolUseCard
        block={{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls -la" } }}
      />,
    );
    expect(html).toMatch(/class="[^"]*min-w-0[^"]*overflow-hidden[^"]*/);
  });
});

describe("AssistantMessageBody overflow classes", () => {
  it("root div has min-w-0 and w-full to prevent flex child overflow", () => {
    const html = renderToStaticMarkup(
      <AssistantMessageBody
        blocks={[{ type: "text", text: "Hello" }]}
        toolResults={{}}
      />,
    );
    expect(html).toMatch(/class="[^"]*min-w-0[^"]*w-full[^"]*/);
  });

  it("thinking block details element has min-w-0 and overflow-hidden", () => {
    const html = renderToStaticMarkup(
      <AssistantMessageBody
        blocks={[{ type: "thinking", thinking: "Let me think..." }]}
        toolResults={{}}
      />,
    );
    expect(html).toMatch(/class="[^"]*min-w-0[^"]*overflow-hidden[^"]*/);
  });
});
