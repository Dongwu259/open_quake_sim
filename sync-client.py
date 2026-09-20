#!/usr/bin/env python3
"""
网站文件同步工具 — 客户端
所有传输数据使用预共享密钥进行 AES-GCM 加密。
替代 scp -r，支持 Windows/Mac/Linux。

三种模式:
  mirror       完全一致 — 删除服务端多余文件
  incremental  增量更新 — 只上传变更的文件
  overwrite    全覆盖   — 和 scp -r 一样，不管多余文件

用法:
  python sync-client.py -m mirror   --local D:/quake_sim --secret 密码
  python sync-client.py -m incremental --local . --secret 密码
  python sync-client.py -m overwrite  --local . --secret 密码
  python sync-client.py -m mirror --dry-run --secret 密码   # 先看差异
"""

import os
import sys
import json
import base64
import hashlib
import argparse
import time
from pathlib import Path

import requests
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

# ─── 默认配置 ───────────────────────────────────────────────
DEFAULT_SERVER_HOST = "http://你的服务器IP"  # 改成你的服务器 IP
DEFAULT_SERVER_PORT = 7788
DEFAULT_LOCAL = "."
PBKDF2_ITERATIONS = 600_000

DEFAULT_EXCLUDE = [
    'node_modules',
    '.git',
    '__pycache__',
    '.DS_Store',
    '*.pyc',
    '.venv',
    'env',
    '.env',
    '.env.local',
    '*.pem',
    '*.key',
    '网站文件上传指南.txt',
    # Local-only dev/test artifacts: never uploaded (the browser probe dir
    # alone holds thousands of screenshots + Edge profile files)
    '.browser-test',
    '.cache',
    'tests',
    # Server-owned runtime state: never overwrite or delete during a code deploy.
    'recordings',
    'admin_password.txt',
    'api_keys.json',
    'counter.json',
    'daily_visits.json',
    'expiry.json',
    'ratelimit.json',
    'settings.json',
    'traffic.json',
    'users.json',
    'webhooks.json',
    'errors.json',
    'iplogs.json',
    '*.log',
    # GSI DEM local-only build intermediates (356MB raw mosaics + 261MB tile
    # cache): regenerable via tools/fetch-gsi-dem.js; the server only needs
    # the blended public/geojson/grids/jp-*-gsi.json outputs.
    'public/geojson/gsi/',
    'tools/data/gsi-tiles/',
]

# Excluded paths that mirror mode MAY still delete from the server: pure local
# junk that should be cleaned off the server, not preserved. Everything else in
# DEFAULT_EXCLUDE is delete-protected (see the to_delete filter in main()).
MIRROR_CLEANUP = [
    '.browser-test',
    # .cache held local-only probes/downloads/Edge profiles AND once carried
    # hardcoded NIED credentials in two helper scripts (since sanitized) —
    # a 2026-08-30 sync gap uploaded ~8.8k of its files to the server; mirror
    # runs must purge them instead of protecting them.
    '.cache',
]


# ─── 加密工具 ───────────────────────────────────────────────

KDF_SALT = b"sync-tool-v2"   # 2026-08: was sync-tool-v1 — must match sync-server.py

def derive_key(password: str) -> bytes:
    """用 PBKDF2 从密码派生 Fernet 密钥"""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=KDF_SALT,
        iterations=PBKDF2_ITERATIONS,
    )
    return base64.urlsafe_b64encode(kdf.derive(password.encode()))


class SyncSession:
    """封装加密通信的 requests session"""

    def __init__(self, server_url, password):
        key = derive_key(password)
        self.fernet = Fernet(key)
        self.server_url = server_url.rstrip('/')
        self.session = requests.Session()
        self.session.headers.update({'X-Auth-Token': password})
        self.timeout = (15, 300)

    def _encrypt(self, data: dict) -> str:
        """加密请求体"""
        plain = json.dumps(data, ensure_ascii=False)
        return self.fernet.encrypt(plain.encode()).decode()

    def _decrypt(self, resp: requests.Response) -> dict:
        """解密响应体"""
        raw = resp.json()
        decrypted = self.fernet.decrypt(raw['data'].encode())
        return json.loads(decrypted)

    def ping(self) -> dict:
        """测试连通性"""
        resp = self.session.get(f"{self.server_url}/ping", timeout=15)
        resp.raise_for_status()
        return self._decrypt(resp)

    def manifest(self, files: dict, mode: str) -> dict:
        """发送文件清单，获取差异"""
        encrypted = self._encrypt({'files': files, 'mode': mode})
        resp = self.session.post(
            f"{self.server_url}/manifest",
            json={'data': encrypted},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return self._decrypt(resp)

    def upload(self, rel_path: str, file_bytes: bytes) -> dict:
        """上传单个文件，遇到 429 自动重试"""
        content_b64 = base64.b64encode(file_bytes).decode()
        encrypted = self._encrypt({
            'path': rel_path,
            'content_base64': content_b64,
        })
        for attempt in range(5):
            resp = self.session.post(
                f"{self.server_url}/upload",
                json={'data': encrypted},
                timeout=self.timeout,
            )
            if resp.status_code == 429:
                wait = min(5 * (attempt + 1), 30)
                print(f"  ⏳ 429 限速，等待 {wait}s 后重试 (attempt {attempt+1}/5)")
                time.sleep(wait)
                continue
            resp.raise_for_status()
            return self._decrypt(resp)
        resp.raise_for_status()  # 最后一次尝试仍失败则抛异常
        return self._decrypt(resp)

    def delete_files(self, paths: list) -> dict:
        """批量删除文件"""
        encrypted = self._encrypt({'paths': paths})
        resp = self.session.post(
            f"{self.server_url}/delete",
            json={'data': encrypted},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return self._decrypt(resp)

    def status(self) -> dict:
        """查询服务器状态"""
        resp = self.session.get(f"{self.server_url}/status", timeout=15)
        resp.raise_for_status()
        return self._decrypt(resp)


# ─── 工具函数 ───────────────────────────────────────────────

def file_hash(filepath):
    h = hashlib.sha256()
    with open(filepath, 'rb') as f:
        while True:
            chunk = f.read(65536)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def match_exclude(rel_path, patterns):
    for pattern in patterns:
        p = pattern.replace('\\', '/')
        if p.endswith('/'):
            if rel_path.startswith(p) or rel_path == p.rstrip('/'):
                return True
        elif p.startswith('*'):
            if rel_path.endswith(p[1:]):
                return True
        else:
            # Bare names match at any depth (gitignore-style): nested junk
            # dirs like tools/.browser-test or tools/__pycache__ must be
            # excluded too, not just their root-level namesakes.
            if (rel_path == p or rel_path.startswith(p + '/')
                    or ('/' + p + '/') in rel_path or rel_path.endswith('/' + p)):
                return True
    return False


def scan_local_files(local_dir, exclude_patterns):
    """扫描本地目录，返回 {rel_path: {size, sha256, mtime}}"""
    result = {}
    local = os.path.realpath(local_dir)

    for root, dirs, files in os.walk(local):
        rel_root = os.path.relpath(root, local)
        if rel_root == '.':
            rel_root = ''

        dirs[:] = [
            d for d in dirs
            if not match_exclude(
                os.path.join(rel_root, d).replace('\\', '/'),
                exclude_patterns
            )
        ]

        for f in files:
            rel_path = os.path.relpath(os.path.join(root, f), local)
            rel_path = rel_path.replace('\\', '/')

            if match_exclude(rel_path, exclude_patterns):
                continue

            full_path = os.path.join(root, f)
            try:
                stat = os.stat(full_path)
                result[rel_path] = {
                    'size': stat.st_size,
                    'sha256': file_hash(full_path),
                    'mtime': stat.st_mtime,
                }
            except OSError as e:
                print(f"  ⚠️  无法读取 {rel_path}: {e}")

    return result


def format_size(n):
    for unit in ['B', 'KB', 'MB', 'GB']:
        if abs(n) < 1024:
            return f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def progress_bar(current, total, prefix='', suffix='', length=40):
    if total == 0:
        print(f"\r{prefix}: {'完成':>8}  {suffix}", end='')
        return
    filled = int(length * current / total)
    bar = '█' * filled + '─' * (length - filled)
    pct = f"{100 * current / total:.0f}%"
    print(f"\r{prefix}: |{bar}| {pct}  {suffix}", end='')
    if current == total:
        print()


# ─── 主逻辑 ─────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(
        description='网站文件同步 — 客户端（加密传输）',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
模式:
  mirror       完全一致 — 上传变更 + 删除服务端多余文件
  incremental  增量更新 — 只上传变更文件
  overwrite    全覆盖   — 上传所有文件（和 scp -r 一致）

示例:
  %(prog)s -m mirror   --local D:/quake_sim --secret 密码
  %(prog)s -m incremental --local . --secret 密码
  %(prog)s -m mirror --dry-run --secret 密码
        """)
    parser.add_argument('-m', '--mode', required=True,
                        choices=['mirror', 'incremental', 'overwrite'],
                        help='同步模式')
    parser.add_argument('--server', default=None,
                        help=f'服务器地址（默认 {DEFAULT_SERVER_HOST}）')
    parser.add_argument('--port', type=int, default=DEFAULT_SERVER_PORT,
                        help=f'服务端端口（默认 {DEFAULT_SERVER_PORT}）')
    parser.add_argument('--url', default=None,
                        help='完整服务器URL（如 https://dwfileshare.top/sync，覆盖 --server 和 --port）')
    parser.add_argument('-s', '--secret', default=None,
                        help='加密密钥（默认从 SYNC_SECRET 环境变量读取）')
    parser.add_argument('-l', '--local', default=None,
                        help='本地网站目录（默认从 SYNC_LOCAL 环境变量或当前目录读取）')
    parser.add_argument('-e', '--exclude', action='append', default=[],
                        help='排除文件/目录（可多次使用）')
    parser.add_argument('-n', '--dry-run', action='store_true',
                        help='干跑模式：只显示差异，不实际写入')
    parser.add_argument('-v', '--verbose', action='store_true',
                        help='详细输出')
    parser.add_argument('--status', action='store_true',
                        help='仅查询服务器状态')

    args = parser.parse_args()

    # 只查状态
    if args.status:
        if args.url:
            server_url = args.url.rstrip('/')
        else:
            server_url = (args.server or os.environ.get('SYNC_SERVER', DEFAULT_SERVER_HOST)) + f":{args.port}"
        secret = args.secret or os.environ.get('SYNC_SECRET', '')
        if not secret:
            print("❌ 需要 --secret")
            sys.exit(1)
        session = SyncSession(server_url, secret)
        info = session.status()
        print(f"目标目录: {info['target']}")
        print(f"文件数:   {info['file_count']}")
        print(f"目录数:   {info['dir_count']}")
        print(f"总大小:   {format_size(info['total_size'])} ({info['total_size_mb']} MB)")
        return

    server_host = args.server or os.environ.get('SYNC_SERVER', DEFAULT_SERVER_HOST)
    secret = args.secret or os.environ.get('SYNC_SECRET', '')
    local_dir = args.local or os.environ.get('SYNC_LOCAL', DEFAULT_LOCAL)

    exclude_patterns = args.exclude + [
        p for p in DEFAULT_EXCLUDE if p not in args.exclude
    ]

    if not secret:
        print("❌ 错误：未设置密钥")
        print("   使用 --secret 密码 或设置环境变量 SYNC_SECRET")
        sys.exit(1)

    if not os.path.isdir(local_dir):
        print(f"❌ 错误：本地目录不存在: {local_dir}")
        sys.exit(1)

    if args.url:
        server_url = args.url.rstrip('/')
    else:
        server_url = f"{server_host}:{args.port}"

    mode_names = {
        'mirror': '完全一致 (Mirror)',
        'incremental': '增量更新 (Incremental)',
        'overwrite': '全覆盖 (Overwrite)',
    }

    # 关闭 SSL 警告（我们用的 HTTP + 应用层加密）
    import urllib3
    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    print()
    print('=' * 55)
    print('  网站文件同步工具（加密传输）')
    print('=' * 55)
    print(f'  模式:     {mode_names[args.mode]}')
    print(f'  服务器:   {server_url}')
    print(f'  本地目录: {os.path.realpath(local_dir)}')
    print(f'  加密:     ✅ AES-256-GCM（预共享密钥）')
    if args.dry_run:
        print('  🟡 干跑模式 — 不会实际写入任何文件')
    print('=' * 55)
    print()

    session = SyncSession(server_url, secret)

    # ─── 第一步：连通性检查 ─────────────────────────────────
    print('🔍 检查服务器连接...', end=' ')
    try:
        info = session.ping()
        print(f'✅  目标目录: {info["target"]}')
        print()
    except requests.exceptions.ConnectionError:
        print(f'\n❌ 无法连接到 {server_url}')
        print('   请检查：')
        print('   1. 服务端是否已启动')
        print('   2. 防火墙是否放行端口')
        print('   3. 地址是否正确')
        sys.exit(1)
    except Exception as e:
        print(f'\n❌ 连接失败：{e}')
        sys.exit(1)

    # ─── 第二步：扫描本地文件 ──────────────────────────────
    print(f'📂 扫描本地文件...', end=' ')
    sys.stdout.flush()
    t0 = time.time()
    local_files = scan_local_files(local_dir, exclude_patterns)
    elapsed = time.time() - t0
    total_local_size = sum(f['size'] for f in local_files.values())
    print(f'共 {len(local_files)} 个文件（{format_size(total_local_size)}）耗时 {elapsed:.1f}s')
    print()

    # ─── 第三步：模式3 (Overwrite) 直接上传 ────────────────
    if args.mode == 'overwrite':
        print(f'📤 全覆盖模式：直接上传所有文件（加密传输）...')
        total = len(local_files)
        success = 0
        uploaded = 0
        total_bytes = total_local_size

        for i, rel_path in enumerate(sorted(local_files.keys()), 1):
            full_path = os.path.join(local_dir, rel_path)
            size = local_files[rel_path]['size']

            try:
                with open(full_path, 'rb') as f:
                    file_bytes = f.read()
                session.upload(rel_path, file_bytes)
                success += 1
                uploaded += size

                if args.verbose:
                    print(f'  [{i}/{total}] ✅ {rel_path} ({format_size(size)})')
                elif total > 5:
                    progress_bar(i, total, '上传进度',
                                 f'{format_size(uploaded)}/{format_size(total_bytes)}')

            except Exception as e:
                print(f'\n  ❌ [{i}/{total}] {rel_path} - {e}')

        if not args.verbose and total > 5:
            print()
        print(f'\n✅ 全覆盖完成: {success}/{total} 个文件\n')
        return

    # ─── 第四步：发送清单对比 ──────────────────────────────
    print('📋 发送清单对比差异（加密传输）...', end=' ')
    sys.stdout.flush()
    t0 = time.time()

    try:
        diff = session.manifest(local_files, args.mode)
    except Exception as e:
        print(f'\n❌ 清单对比失败：{e}')
        sys.exit(1)

    elapsed = time.time() - t0

    to_upload = diff['to_upload']
    to_delete = diff['to_delete']
    up_to_date = diff['up_to_date']

    # Mirror-mode delete protection: the server computes to_delete as
    # "on server but not in the local manifest", which would wipe every
    # excluded path (runtime json, recordings/, node_modules, ...). Filter
    # those out client-side; only MIRROR_CLEANUP junk dirs may be purged.
    if args.mode == 'mirror' and to_delete:
        protected = [
            p for p in to_delete
            if match_exclude(p, exclude_patterns)
            and not match_exclude(p, MIRROR_CLEANUP)
        ]
        if protected:
            keep = set(protected)
            to_delete = [p for p in to_delete if p not in keep]
            print(f'   🛡️  保护 {len(protected)} 个排除/运行时文件不被删除')

    upload_size = sum(
        local_files[p]['size'] for p in to_upload if p in local_files
    )

    print(f'✅ 对比完成（耗时 {elapsed:.1f}s）')
    print(f'   需上传: {len(to_upload)} 个文件（{format_size(upload_size)}）')
    print(f'   已一致: {len(up_to_date)} 个文件')
    if args.mode == 'mirror' and to_delete:
        print(f'   需删除: {len(to_delete)} 个文件')
    print()

    # ─── 干跑模式 ──────────────────────────────────────────
    if args.dry_run:
        if to_upload:
            print('📤 将上传的文件:')
            for p in sorted(to_upload):
                s = local_files.get(p, {}).get('size', 0)
                print(f'  + {p} ({format_size(s)})')

        if to_delete and args.mode == 'mirror':
            print(f'\n🗑️ 将被删除的文件:')
            for p in sorted(to_delete)[:50]:
                print(f'  - {p}')
            if len(to_delete) > 50:
                print(f'  ... 还有 {len(to_delete) - 50} 个')

        if not to_upload and not (to_delete and args.mode == 'mirror'):
            print('✅ 已经是最新，无需操作')
        print()
        return

    # ─── 第五步：上传文件 ──────────────────────────────────
    if to_upload:
        print(f'📤 上传 {len(to_upload)} 个文件（{format_size(upload_size)}）...')
        total = len(to_upload)
        success = 0
        uploaded_bytes = 0

        for i, rel_path in enumerate(sorted(to_upload), 1):
            full_path = os.path.join(local_dir, rel_path)
            size = local_files.get(rel_path, {}).get('size', 0)

            try:
                with open(full_path, 'rb') as f:
                    file_bytes = f.read()
                session.upload(rel_path, file_bytes)
                success += 1
                uploaded_bytes += size

                if args.verbose:
                    print(f'  [{i}/{total}] ✅ {rel_path} ({format_size(size)})')
                elif total > 5:
                    progress_bar(i, total, '上传进度',
                                 f'{format_size(uploaded_bytes)}/{format_size(upload_size)}')

            except Exception as e:
                print(f'\n  ❌ [{i}/{total}] {rel_path} - {e}')

        if not args.verbose and total > 5:
            print()
        print(f'   上传完成: {success}/{total} 个文件\n')
    else:
        print('✅ 没有文件需要上传\n')

    # ─── 第六步：删除多余文件（仅 Mirror 模式）──────────────
    if args.mode == 'mirror' and to_delete:
        print(f'🗑️ 删除 {len(to_delete)} 个多余文件...')

        try:
            result = session.delete_files(to_delete)
            deleted_count = len(result.get('deleted', []))
            dirs_count = len(result.get('removed_dirs', []))
            failed_count = len(result.get('failed', []))

            print(f'   已删除: {deleted_count} 个文件')
            if dirs_count:
                print(f'   清理空目录: {dirs_count} 个')
            if failed_count:
                print(f'   失败: {failed_count} 个')
                if args.verbose:
                    for f in result['failed']:
                        print(f'     ❌ {f["path"]}: {f["error"]}')
        except Exception as e:
            print(f'   ❌ 删除请求失败: {e}')

        print()

    print('=' * 55)
    print('  ✅ 同步完成！')
    print('=' * 55)
    if to_upload:
        print(f'  更新了 {len(to_upload)} 个文件（{format_size(upload_size)}）')
    if args.mode == 'mirror' and to_delete:
        print(f'  删除了 {len(to_delete)} 个多余文件')
    print()


if __name__ == '__main__':
    main()
