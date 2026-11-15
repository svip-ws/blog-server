import os
import sys
import subprocess

def check_env():
    print("--- ✦ 检查并配置 Holo Card Studio 环境 ---")
    try:
        import PIL
        print("✓ Pillow 已就绪, 版本:", PIL.__version__)
    except ImportError:
        print("⚠️ 未找到 Pillow，正在自动安装...")
        try:
            subprocess.check_call([sys.executable, "-m", "pip", "install", "Pillow"])
            print("✓ Pillow 自动安装成功！")
        except Exception as e:
            print("❌ 安装 Pillow 失败:", e)

    tools_dir = os.path.join(os.path.dirname(__file__), "../tools")
    os.makedirs(tools_dir, exist_ok=True)
    print("✓ 引擎依赖工具目录已确认:", os.path.abspath(tools_dir))

if __name__ == "__main__":
    check_env()
