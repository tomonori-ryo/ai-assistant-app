#!/usr/bin/env python3
"""
AIパーソナル秘書システム - ドキュメント変換ツール

MarkItDownライブラリを使用して、様々なファイル形式を
Markdownに変換するユーティリティスクリプト。

使用例:
    python doc_converter.py input.pdf
    python doc_converter.py input.docx --output custom_output.md
    python doc_converter.py --batch input_folder/
"""

import argparse
import os
import sys
from pathlib import Path
from typing import List, Optional

try:
    from markitdown import MarkItDown
except ImportError:
    print("エラー: markitdownライブラリがインストールされていません。")
    print("以下のコマンドでインストールしてください:")
    print("pip install markitdown")
    sys.exit(1)


class DocumentConverter:
    """MarkItDownを使用したドキュメント変換クラス"""
    
    def __init__(self):
        """コンバーターを初期化"""
        self.markitdown = MarkItDown()
        self.supported_extensions = {
            '.pdf', '.docx', '.doc', '.pptx', '.ppt', 
            '.xlsx', '.xls', '.html', '.htm', '.txt'
        }
    
    def convert_file(self, input_path: str, output_path: Optional[str] = None) -> bool:
        """
        単一ファイルをMarkdownに変換
        
        Args:
            input_path: 入力ファイルのパス
            output_path: 出力ファイルのパス（省略時は自動生成）
        
        Returns:
            bool: 変換成功時True
        """
        input_file = Path(input_path)
        
        # ファイル存在確認
        if not input_file.exists():
            print(f"エラー: ファイルが見つかりません - {input_path}")
            return False
        
        # 拡張子チェック
        if input_file.suffix.lower() not in self.supported_extensions:
            print(f"エラー: サポートされていないファイル形式 - {input_file.suffix}")
            print(f"サポート形式: {', '.join(self.supported_extensions)}")
            return False
        
        # 出力パス生成
        if output_path is None:
            output_path = input_file.with_suffix('.md')
        
        try:
            print(f"変換中: {input_path} → {output_path}")
            
            # MarkItDownで変換実行
            result = self.markitdown.convert(str(input_file))
            
            # 結果をファイルに保存
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write(result.text_content)
            
            print(f"✅ 変換完了: {output_path}")
            return True
            
        except Exception as e:
            print(f"❌ 変換エラー: {e}")
            return False
    
    def batch_convert(self, input_dir: str, output_dir: Optional[str] = None) -> int:
        """
        フォルダ内のファイルを一括変換
        
        Args:
            input_dir: 入力ディレクトリのパス
            output_dir: 出力ディレクトリのパス（省略時は入力と同じ）
        
        Returns:
            int: 変換成功したファイル数
        """
        input_path = Path(input_dir)
        
        if not input_path.is_dir():
            print(f"エラー: ディレクトリが見つかりません - {input_dir}")
            return 0
        
        if output_dir is None:
            output_path = input_path
        else:
            output_path = Path(output_dir)
            output_path.mkdir(parents=True, exist_ok=True)
        
        success_count = 0
        
        # 対象ファイルを検索
        for file_path in input_path.rglob('*'):
            if file_path.is_file() and file_path.suffix.lower() in self.supported_extensions:
                # 相対パスを維持した出力パス生成
                relative_path = file_path.relative_to(input_path)
                output_file = output_path / relative_path.with_suffix('.md')
                output_file.parent.mkdir(parents=True, exist_ok=True)
                
                if self.convert_file(str(file_path), str(output_file)):
                    success_count += 1
        
        print(f"\n📊 変換完了: {success_count}件のファイルを処理しました")
        return success_count


def main():
    """メイン関数"""
    parser = argparse.ArgumentParser(
        description="MarkItDownを使用したドキュメント変換ツール",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
使用例:
  %(prog)s document.pdf                    # PDFをMarkdownに変換
  %(prog)s document.docx -o output.md      # 出力ファイル名を指定
  %(prog)s --batch input_folder/           # フォルダ内を一括変換
  %(prog)s --batch input/ -o output/       # 出力先フォルダを指定
        """
    )
    
    parser.add_argument(
        'input',
        help='入力ファイルまたはディレクトリのパス'
    )
    
    parser.add_argument(
        '-o', '--output',
        help='出力ファイルまたはディレクトリのパス'
    )
    
    parser.add_argument(
        '--batch',
        action='store_true',
        help='ディレクトリ内のファイルを一括変換'
    )
    
    parser.add_argument(
        '--list-formats',
        action='store_true',
        help='サポートされているファイル形式一覧を表示'
    )
    
    args = parser.parse_args()
    
    converter = DocumentConverter()
    
    # サポート形式一覧表示
    if args.list_formats:
        print("サポートされているファイル形式:")
        for ext in sorted(converter.supported_extensions):
            print(f"  {ext}")
        return
    
    # バッチ変換
    if args.batch:
        converter.batch_convert(args.input, args.output)
    else:
        # 単一ファイル変換
        converter.convert_file(args.input, args.output)


if __name__ == '__main__':
    main()
