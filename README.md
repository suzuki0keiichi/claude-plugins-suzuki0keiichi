# Claude Agent Plugins (Personal)

## 日本語

### このリポジトリについて

このリポジトリは、私個人が日常的に使っている **Claude Code 用のエージェント／プラグイン**を公開しているものです。  
主用途は **自分自身と自分の所属する環境で使うこと**ですが、他の方が使うことを妨げる意図はありません。

**自由に使ってください。**

---

### ライセンス

このリポジトリの内容は **Apache License 2.0** のもとで公開されています。  
詳細は `LICENSE` ファイルを参照してください。

- 商用利用可
- 改変可
- 再配布可
- 特許利用許諾を含む

---

### コントリビューション（PR について）

このリポジトリは **個人利用を主目的**としているため、

- PR を積極的に受け付ける予定はありません
- Issue 管理や要望対応も保証しません

あらかじめご了承ください。

ただし、

- **Fork は完全に自由**
- 自分用に改変することを前提としています

ので、必要に応じて好きな形に育ててください。

---

### なぜ個人用として公開しているのか

理由はシンプルです。

- 自分の需要・課題感に強く最適化したい
- 遠慮なく壊したり作り直したい
- 意思決定を軽くしたい

そのため「共同開発前提」にはしていません。

一方で、

- 同じような問題意識を持つ人が
- 勝手に使って、勝手に fork して
- 勝手に役立ててくれる

ことは歓迎しています。

---

### なぜ今このエージェントが必要なのか

Claude のモデルや公式エージェントは今後確実に進化していくと思っています。  
このリポジトリのエージェントたちは、**最終的には不要になる可能性が高い**です。

それでも今これを作っている理由は、

> 現時点では、エージェントやプロジェクトが  
> 「迷子にならないためのガードレール」がまだ足りない

と感じているからです。

- プロダクトのコンセプトが削られていく
- 進行が目的を見失う
- 技術的・組織的な都合がすべてを決めてしまう

そういったことを防ぐための **暫定的な補助輪**として、このエージェント群を追加しています。

---

### Agent Teams（実験的機能）

`project-coordinator` プラグインは **Agent Teams** に対応しています。
coordinator と investigator がチームメイトとして並行動作し、直接メッセージをやり取りできます。

Agent Teams は実験的機能のため、デフォルトでは無効です。
有効にするには `settings.json` に以下を追加してください：

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

無効の場合は従来のサブエージェント方式にフォールバックします。

---

### 最後に

これは「完成されたフレームワーク」ではありません。  
あくまで **今の自分にとって必要な道具**です。

- 合わなければ無視してください
- 参考になれば持って行ってください
- 公式がより良いものを出したら、そちらを使えば良いと思っています

そのくらいの距離感で付き合ってもらえると嬉しいです。

---

## English

### About This Repository

This repository contains **Claude Code agents and plugins** that I primarily use for my own work.  
While it is published publicly, its main purpose is **personal use**, not community-driven development.

Anyone is free to use it.

---

### License

The contents of this repository are released under the **Apache License, Version 2.0**.  
See the `LICENSE` file for full details.

- Commercial use allowed
- Modification allowed
- Redistribution allowed
- Includes patent license

---

### Contributions (Pull Requests)

This repository is **not intended as a collaborative project**.

- Pull requests are not actively accepted
- Issue tracking and feature requests are not guaranteed

Please understand this in advance.

However:

- **Forking is fully encouraged**
- You are expected to adapt it for your own use

---

### Why This Is a Personal Repository

The reasons are simple:

- I want to optimize these agents for my own needs
- I want to freely change or rewrite them
- I want lightweight decision-making

That is why this is not run as a shared project.

At the same time, I welcome others who:

- Have similar problems
- Use this as a reference
- Fork it and adapt it independently

---

### Why These Agents Exist Now

Claude models and official agents will almost certainly improve over time.  
These agents may eventually become unnecessary.

They exist now because I believe:

> At the moment, there are not enough guardrails to keep agents and projects from drifting.

Specifically:

- Product concepts get eroded
- Execution loses sight of original intent
- Technical and organizational convenience dominates decisions

These agents serve as **temporary guardrails** to prevent that.

---

### Agent Teams (Experimental)

The `project-coordinator` plugin supports **Agent Teams**.
The coordinator and investigator run as teammates, communicating directly via messages.

Agent Teams is experimental and disabled by default.
To enable, add the following to your `settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

When disabled, the plugin falls back to the traditional subagent approach.

---

### Final Notes

This is not a polished framework.  
It is simply a set of tools that are useful to me right now.

- Ignore it if it doesn’t fit
- Take it if it helps
- Replace it when something better exists

That is the intended relationship.
