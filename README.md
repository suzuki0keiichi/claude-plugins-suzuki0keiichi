# Claude Code Plugins (Personal)

## 日本語

### このリポジトリについて

このリポジトリは、私個人が日常的に使っている **Claude Code 用のプラグイン**を公開しているものです。  
主用途は **自分自身と自分の所属する環境で使うこと**ですが、他の方が使うことを妨げる意図はありません。

**自由に使ってください。**

---

### 収録プラグイン

| プラグイン | 役割 |
|-----------|------|
| `graphrag-knowledge` | プロジェクトの永続知識グラフ (採用判断/却下案/制約/目的/リスク/運用知識) を、vault (Obsidian Markdown) を単一正本として安全に読み書きするスキル群 + CLI。設計レビュー・PR レビュー・checkpoint/resume もこのグラフを背骨に行う |
| `ssh-operator` | リモートマシンを SSH 操作するスキル。認証情報はローカルに置いたまま、プロジェクト内のヘルパースクリプトを経由することでパーミッション許可 (Always allow) を安定させる |

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

### かつてあった「補助輪」プラグインについて

このリポジトリには以前、ガードレール系のプラグインがありました（プロダクトコンセプトの防衛、調査の迷子防止、プロジェクト固有レビューの生成）。

当初からこの README には

> Claude のモデルや公式エージェントは今後確実に進化していくと思っています。  
> このリポジトリのエージェントたちは、**最終的には不要になる可能性が高い**です。

と書いていましたが、実際にその通りになったため、2026-07 に削除しました。モデル自身の判断力と公式機能（コードレビュー、コンテキスト管理、マルチエージェント）がその役割を吸収しています。

残している 2 つは、モデルが賢くなっても残る構造的な隙間を埋めるものです。

- **graphrag-knowledge**: セッションのコンテキストは揮発する。採用判断・却下した選択肢・運用で踏んだ地雷をセッションを跨いで持ち越すには、外部の永続知識が要る
- **ssh-operator**: `ssh <host> <任意コマンド>` の常時許可は危険。プロジェクト内の固定パスのヘルパーを経由することで、安全に常時許可できるようにする

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

This repository contains **Claude Code plugins** that I primarily use for my own work.  
While it is published publicly, its main purpose is **personal use**, not community-driven development.

Anyone is free to use it.

---

### Included Plugins

| Plugin | Role |
|--------|------|
| `graphrag-knowledge` | A persistent project knowledge graph (decisions / rejected options / constraints / goals / risks / operational knowledge), read and written safely through a vault (Obsidian Markdown) as the single source of truth. Design review, PR review, and checkpoint/resume are built on this graph |
| `ssh-operator` | Operate remote machines via SSH. Credentials stay local, and routing everything through a project-local helper script keeps permission grants ("Always allow") stable |

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

- I want to optimize these plugins for my own needs
- I want to freely change or rewrite them
- I want lightweight decision-making

That is why this is not run as a shared project.

At the same time, I welcome others who:

- Have similar problems
- Use this as a reference
- Fork it and adapt it independently

---

### About the Former "Guardrail" Plugins

This repository used to contain guardrail-style plugins (protecting product concepts from erosion, keeping investigations from getting lost, generating project-specific reviews).

From the beginning, this README said:

> Claude models and official agents will almost certainly improve over time.  
> These agents may eventually become unnecessary.

That is exactly what happened, so they were removed in 2026-07. Model judgment and official features (code review, context management, multi-agent orchestration) have absorbed their roles.

The two remaining plugins fill structural gaps that model intelligence alone does not solve:

- **graphrag-knowledge**: Session context is volatile. Carrying decisions, rejected options, and operational landmines across sessions requires external persistent knowledge.
- **ssh-operator**: Blanket permission for `ssh <host> <any command>` is dangerous. Routing through a fixed project-local helper makes "Always allow" safe.

---

### Final Notes

This is not a polished framework.  
It is simply a set of tools that are useful to me right now.

- Ignore it if it doesn't fit
- Take it if it helps
- Replace it when something better exists

That is the intended relationship.
