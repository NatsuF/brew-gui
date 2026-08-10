# -*- mode: python ; coding: utf-8 -*-
"""BrewMaster PyInstaller spec — 生成 macOS .app 应用包（无终端窗口、无程序坞跳动）。"""

import os

block_cipher = None

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=[],
    datas=[
        ('templates', 'templates'),
        ('static', 'static'),
        ('sudo_askpass.sh', '.'),
    ],
    hiddenimports=[
        'flask',
        'jinja2',
        'markupsafe',
        'itsdangerous',
        'click',
        'werkzeug',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='BrewMaster',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='BrewMaster',
)

app = BUNDLE(
    coll,
    name='BrewMaster.app',
    icon='assets/BrewMaster.icns',
    bundle_identifier='com.brewmaster.app',
    info_plist={
        'CFBundleDisplayName': 'BrewMaster',
        'CFBundleShortVersionString': '1.0.0',
        'CFBundleVersion': '1.0.0',
        'NSHighResolutionCapable': True,
        'LSMinimumSystemVersion': '11.0',
        'LSUIElement': True,
    },
)
