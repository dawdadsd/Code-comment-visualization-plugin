/**
 * gitService.test.ts - GitService 集成测试（真实 git 命令 + 临时仓库）
 *
 * 覆盖：
 * - "最后修改者"按整个文件最近一次提交计算，而非类声明行的 blame
 *   （只改方法体、不动类声明行时，旧实现会错误地停留在首次提交者）
 * - 原始作者 = 首次提交作者
 * - 非 git 仓库目录不抛异常，返回 Unknown 占位
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { GitService } from "../src/services/GitService";

describe("GitService 文件级最后修改者", () => {
  let dir: string;
  let service: GitService;

  const git = (args: string): string =>
    execSync(`git ${args}`, { cwd: dir, stdio: "pipe" }).toString().trim();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "git-service-test-"));
    git("init -q");
    git('config user.name "Alice"');
    git('config user.email "alice@example.com"');
    service = new GitService();
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("最后修改者取整个文件最近一次提交，而非类声明行 blame", async () => {
    const file = path.join(dir, "app.ts");
    fs.writeFileSync(
      file,
      "/** doc */\nclass App {\n  a(): void {}\n}\n",
    );
    git("add app.ts");
    git('commit -q -m "init by Alice"');

    // Bob 仅修改方法体（新增 b()），类声明行与文件头注释均未动。
    // 旧实现按类声明行 blame 会错误地显示 Alice。
    git('config user.name "Bob"');
    git('config user.email "bob@example.com"');
    fs.writeFileSync(
      file,
      "/** doc */\nclass App {\n  a(): void {}\n  b(): void {}\n}\n",
    );
    git("add app.ts");
    git('commit -q -m "add b by Bob"');

    const expectedDate = git('log -n 1 --format="%ad" --date=short -- app.ts');

    // classLine = 1（类声明在 0-based 第 2 行）：旧实现 blame 该行 = Alice
    const info = await service.getClassGitInfo(file, 1);

    expect(info?.author).toBe("Alice"); // 原始作者 = 首次提交
    expect(info?.lastModifier).toBe("Bob"); // 整个文件最近修改者
    expect(info?.lastModifyDate).toBe(expectedDate);
  });

  it("非 git 仓库目录返回 Unknown 占位，不抛异常", async () => {
    const plainDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "git-service-plain-"),
    );
    try {
      const file = path.join(plainDir, "app.ts");
      fs.writeFileSync(file, "class App {}\n");

      const info = await service.getClassGitInfo(file, 0);

      expect(info).not.toBeNull();
      expect(info?.author).toBe("Unknown");
      expect(info?.lastModifier).toBe("Unknown");
      expect(info?.lastModifyDate).toBe("");
    } finally {
      fs.rmSync(plainDir, { recursive: true, force: true });
    }
  });
});
