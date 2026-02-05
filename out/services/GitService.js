"use strict";
/**
 * GitService.ts - Git 信息服务
 *
 * 提供 Git blame 信息查询功能，用于获取代码作者和修改时间
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.gitService = exports.GitService = void 0;
const child_process_1 = require("child_process");
const util_1 = require("util");
const path = __importStar(require("path"));
const execAsync = (0, util_1.promisify)(child_process_1.exec);
/**
 * Git 服务类
 */
class GitService {
    cache = new Map();
    cacheTimeout = 60000; // 1分钟缓存
    /**
     * 获取指定行的 Git blame 信息
     */
    async getBlameForLine(filePath, line) {
        const cacheKey = `${filePath}:${line}`;
        if (this.cache.has(cacheKey)) {
            return this.cache.get(cacheKey) ?? null;
        }
        try {
            const workDir = path.dirname(filePath);
            const fileName = path.basename(filePath);
            // git blame -L 指定行范围，--porcelain 输出机器可读格式
            const { stdout } = await execAsync(`git blame -L ${line + 1},${line + 1} --porcelain "${fileName}"`, { cwd: workDir, timeout: 5000 });
            const info = this.parseBlameOutput(stdout);
            if (info) {
                this.cache.set(cacheKey, info);
                // 设置缓存过期
                setTimeout(() => this.cache.delete(cacheKey), this.cacheTimeout);
            }
            return info;
        }
        catch (error) {
            // Git 命令失败（可能不是 git 仓库）
            console.debug('[GitService] Blame failed:', error);
            return null;
        }
    }
    /**
     * 获取类的 Git 信息（原始作者 + 最后修改者）
     */
    async getClassGitInfo(filePath, classLine) {
        const workDir = path.dirname(filePath);
        const fileName = path.basename(filePath);
        // 先获取类声明行的最后修改者；即使后续 git log 失败也能回退展示。
        const lastModifier = await this.getBlameForLine(filePath, classLine);
        let originalAuthor = '';
        try {
            // 获取文件的第一次提交作者（原始作者）
            // 注意：不要用 "| tail -1" 之类的管道命令，Windows 默认 shell 不支持。
            const { stdout: logOutput } = await execAsync(`git log --follow --diff-filter=A --reverse -n 1 --format="%an|%ad" --date=short -- "${fileName}"`, { cwd: workDir, timeout: 5000 });
            originalAuthor = logOutput.trim().split('|')[0] ?? '';
        }
        catch (error) {
            console.debug('[GitService] Get original author failed:', error);
        }
        return {
            author: originalAuthor || lastModifier?.author || 'Unknown',
            lastModifier: lastModifier?.author || 'Unknown',
            lastModifyDate: lastModifier?.date || '',
        };
    }
    /**
     * 批量获取多行的 blame 信息（更高效）
     */
    async getBlameForLines(filePath, lines) {
        const result = new Map();
        if (lines.length === 0)
            return result;
        try {
            const workDir = path.dirname(filePath);
            const fileName = path.basename(filePath);
            // 构建行范围参数
            const lineArgs = lines.map(l => `-L ${l + 1},${l + 1}`).join(' ');
            const { stdout } = await execAsync(`git blame ${lineArgs} --porcelain "${fileName}"`, { cwd: workDir, timeout: 10000 });
            // 解析多行输出
            const blocks = stdout.split(/(?=^[0-9a-f]{40})/m);
            let lineIndex = 0;
            for (const block of blocks) {
                if (!block.trim())
                    continue;
                const info = this.parseBlameOutput(block);
                if (info && lineIndex < lines.length) {
                    const line = lines[lineIndex];
                    if (line !== undefined) {
                        result.set(line, info);
                    }
                    lineIndex++;
                }
            }
        }
        catch (error) {
            console.debug('[GitService] Batch blame failed:', error);
        }
        return result;
    }
    /**
     * 解析 git blame --porcelain 输出
     */
    parseBlameOutput(output) {
        if (!output.trim())
            return null;
        const lines = output.split('\n');
        let author = '';
        let email = '';
        let date = '';
        let commitHash = '';
        for (const line of lines) {
            if (/^[0-9a-f]{40}/.test(line)) {
                commitHash = line.slice(0, 40);
            }
            else if (line.startsWith('author ')) {
                author = line.slice(7);
            }
            else if (line.startsWith('author-mail ')) {
                email = line.slice(12).replace(/[<>]/g, '');
            }
            else if (line.startsWith('author-time ')) {
                const timestamp = parseInt(line.slice(12), 10);
                date = new Date(timestamp * 1000).toISOString().split('T')[0] ?? '';
            }
        }
        if (!author)
            return null;
        return { author, email, date, commitHash };
    }
    /**
     * 检查当前目录是否是 Git 仓库
     */
    async isGitRepository(filePath) {
        try {
            const workDir = path.dirname(filePath);
            await execAsync('git rev-parse --git-dir', { cwd: workDir, timeout: 2000 });
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * 清除缓存
     */
    clearCache() {
        this.cache.clear();
    }
}
exports.GitService = GitService;
// 单例实例
exports.gitService = new GitService();
//# sourceMappingURL=GitService.js.map