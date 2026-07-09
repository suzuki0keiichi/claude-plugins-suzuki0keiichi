#!/usr/bin/env node
// Proactive Persistence リマインダ (PreToolUse / Bash)。
// stdin の hook 入力 JSON を読み、コマンドが git commit を含む時だけ
// additionalContext で graphrag への書き戻しを促す。常に allow (deny しない)。
// 依存ゼロの素 node — plugin 配布先に node_modules を要求しないため。

// 引用符内 (コミットメッセージ等) の "git commit" に誤爆しないよう、
// 判定前にクォート文字列を潰す。完璧なシェル解析は不要 (単語境界程度の堅さでよい)。
const stripQuoted = (command) =>
  command.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'[^']*'/g, "''");

// git (グローバルオプション任意) commit を単語境界で検出。
// "git commitlint" や "mygit commit" には反応しない。-C <dir> / -c <k=v> 形式の介在は許容。
const GIT_COMMIT_RE = /\bgit(?:\s+-[Cc]\s+\S+|\s+-\S+)*\s+commit\b/;

const isGitCommitCommand = (command) =>
  typeof command === "string" && GIT_COMMIT_RE.test(stripQuoted(command));

const REMINDER = {
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "allow",
    additionalContext:
      "<graphrag write-back check, on commit boundary: (1) Have you written back the adoption decision behind this change, the alternatives you rejected, the risks you hit, and the operational gotchas? If not, write them back via add-* right after the commit (run the duplicate pre-check first). (2) If this focus is now settled, include an op:update setting its active Investigation to state:closed in the same write-back plan — no other natural closing trigger exists; this commit boundary IS the closing moment.>",
  },
};

let raw = "";
try {
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  const input = JSON.parse(raw);
  if (isGitCommitCommand(input?.tool_input?.command)) {
    process.stdout.write(JSON.stringify(REMINDER) + "\n");
  }
} catch {
  // 入力不正でもブロックしない — 何も出さず正常終了
}
process.exit(0);
