# -*- coding: utf-8 -*-
"""轻量 Markdown -> docx 转换器（仅标准库，不依赖 python-docx）。

用法: python md2docx.py
将以下 md 生成到同名 docx:
   PPT大纲.md              -> ppt大纲.docx
   实验创新性分析报告.md     -> 实验创新型分析报告.docx
   芯片设计说明书.md         -> 芯片设计说明书.docx
"""
import zipfile
import re
import os

HERE = os.path.dirname(os.path.abspath(__file__))

# ---------------------------------------------------------------
# XML 工具
# ---------------------------------------------------------------
def esc(s):
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    return s

def inline_runs(text, base_size=22):
    """解析行内 **bold**，返回 run XML 列表。base_size 为半磅(pt*2)。"""
    parts = re.split(r"(\*\*.+?\*\*)", text)
    out = []
    for p in parts:
        if not p:
            continue
        if p.startswith("**") and p.endswith("**"):
            content = p[2:-2]
            out.append(f'<w:r><w:rPr><w:b/><w:sz w:val="{base_size}"/></w:rPr><w:t xml:space="preserve">{esc(content)}</w:t></w:r>')
        else:
            out.append(f'<w:r><w:rPr><w:sz w:val="{base_size}"/></w:rPr><w:t xml:space="preserve">{esc(p)}</w:t></w:r>')
    return "".join(out)

def para(text, size=22, bold=False, color=None, indent=None):
    rpr = f'<w:rPr><w:b/>' if bold else '<w:rPr>'
    if size:
        rpr = f'<w:rPr>' + (f'<w:b/>' if bold else '') + f'<w:sz w:val="{size}"/>'
    rpr += f'<w:color w:val="{color}"/>' if color else ''
    rpr += '</w:rPr>'
    ppr = ''
    if indent:
        ppr = f'<w:pPr><w:ind w:left="{indent}"/></w:pPr>'
    return f'<w:p>{ppr}<w:r>{rpr}<w:t xml:space="preserve">{esc(text)}</w:t></w:r></w:p>'

def heading(text, level):
    sizes = {1: 32, 2: 28, 3: 24}
    colors = {1: "1F3864", 2: "2E5395", 3: "1F4E79"}
    sz = sizes.get(level, 22)
    col = colors.get(level, "1F3864")
    return f'<w:p><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:r><w:rPr><w:b/><w:color w:val="{col}"/><w:sz w:val="{sz}"/></w:rPr><w:t xml:space="preserve">{esc(text)}</w:t></w:r></w:p>'

def code_line(text):
    return (f'<w:p><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>'
            f'<w:ind w:left="240"/></w:pPr>'
            f'<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>'
            f'<w:sz w:val="18"/><w:color w:val="333333"/></w:rPr>'
            f'<w:t xml:space="preserve">{esc(text)}</w:t></w:r></w:p>')

def blockquote(text):
    return (f'<w:p><w:pPr><w:ind w:left="360"/><w:shd w:val="clear" w:color="auto" w:fill="F5F7FA"/></w:pPr>'
            f'<w:r><w:rPr><w:i/><w:color w:val="555555"/><w:sz w:val="21"/></w:rPr>'
            f'<w:t xml:space="preserve">{esc(text)}</w:t></w:r></w:p>')

def table(rows):
    ncols = max(len(r) for r in rows)
    grid_col_w = 10000 // ncols
    grid = "".join(f'<w:gridCol w:w="{grid_col_w}"/>' for _ in range(ncols))
    border = ('<w:tblBorders>'
              '<w:top w:val="single" w:sz="4" w:color="BFBFBF"/>'
              '<w:left w:val="single" w:sz="4" w:color="BFBFBF"/>'
              '<w:bottom w:val="single" w:sz="4" w:color="BFBFBF"/>'
              '<w:right w:val="single" w:sz="4" w:color="BFBFBF"/>'
              '<w:insideH w:val="single" w:sz="4" w:color="BFBFBF"/>'
              '<w:insideV w:val="single" w:sz="4" w:color="BFBFBF"/>'
              '</w:tblBorders>')
    tblPr = f'<w:tblPr><w:tblW w:w="5000" w:type="pct"/>{border}</w:tblPr>'
    trs = []
    for ri, row in enumerate(rows):
        cells = ""
        for ci in range(ncols):
            txt = row[ci] if ci < len(row) else ""
            bold = (ri == 0)
            cell_pr = '<w:tcPr><w:tcW w:w="0" w:type="auto"/></w:tcPr>'
            runs = ""
            if txt:
                # 支持单元格内 **bold**
                for part in re.split(r"(\*\*.+?\*\*)", txt):
                    if not part:
                        continue
                    if part.startswith("**") and part.endswith("**"):
                        runs += f'<w:r><w:rPr><w:b/><w:sz w:val="19"/></w:rPr><w:t xml:space="preserve">{esc(part[2:-2])}</w:t></w:r>'
                    else:
                        runs += f'<w:r><w:rPr><w:sz w:val="19"/></w:rPr><w:t xml:space="preserve">{esc(part)}</w:t></w:r>'
            else:
                runs = '<w:r><w:t xml:space="preserve"></w:t></w:r>'
            if bold:
                runs = runs.replace('<w:rPr><w:sz w:val="19"/>', '<w:rPr><w:b/><w:sz w:val="19"/>') if runs.startswith('<w:r>') else runs
            cells += f'<w:tc>{cell_pr}<w:p>{runs}</w:p></w:tc>'
        trs.append(f'<w:tr>{cells}</w:tr>')
    return f'<w:tbl>{tblPr}<w:tblGrid>{grid}</w:tblGrid>{"".join(trs)}</w:tbl>' + '<w:p/>'

# ---------------------------------------------------------------
# Markdown 解析
# ---------------------------------------------------------------
def md_to_body(md_text):
    lines = md_text.splitlines()
    xmls = []
    i = 0
    in_code = False
    while i < len(lines):
        raw = lines[i]
        line = raw.rstrip()
        stripped = line.strip()

        if stripped.startswith("```"):
            in_code = not in_code
            i += 1
            continue
        if in_code:
            xmls.append(code_line(line))
            i += 1
            continue

        if not stripped:
            i += 1
            continue

        # 表格块：当前行以 | 开头 -> 收集到无 | 为止
        if stripped.startswith("|"):
            rows = []
            while i < len(lines) and "|" in lines[i]:
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                # 跳过分隔行 |---|---|
                if not all(re.fullmatch(r":?-{2,}:?", c or "") for c in cells if c.strip()):
                    rows.append(cells)
                i += 1
            if rows:
                xmls.append(table(rows))
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)$", stripped)
        if m:
            xmls.append(heading(m.group(2), len(m.group(1))))
            i += 1
            continue

        # 引用块
        if stripped.startswith(">"):
            xmls.append(blockquote(stripped.lstrip(">").strip()))
            i += 1
            continue

        # 列表项（统一转文本加前缀）
        m = re.match(r"^[-*]\s+(.*)$", stripped)
        if m:
            xmls.append(para("• " + inline_to_plain(m.group(1)), size=22, indent=240))
            i += 1
            continue
        m = re.match(r"^(\d+[.、])\s+(.*)$", stripped)
        if m:
            xmls.append(para(m.group(1) + " " + m.group(2), size=22, indent=240))
            i += 1
            continue

        # 分隔线
        if re.fullmatch(r"-{3,}|={3,}", stripped):
            i += 1
            continue

        # 普通段落（保留行内粗体）
        ppr = '<w:pPr><w:ind w:left="0"/></w:pPr>'
        xmls.append(f'<w:p>{ppr}{inline_runs(stripped)}</w:p>')
        i += 1
    return "".join(xmls)

def inline_to_plain(text):
    return text.replace("**", "")

# ---------------------------------------------------------------
# 构造 docx 文件（OOXML 最小结构）
# ---------------------------------------------------------------
def build_docx(body_xml):
    document = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        '<w:body>'
        + body_xml +
        '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
        '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
        '</w:body></w:document>'
    )
    content_types = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/word/document.xml" '
        'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
        '</Types>'
    )
    rels = (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" '
        'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
        'Target="word/document.xml"/>'
        '</Relationships>'
    )
    return {
        "[Content_Types].xml": content_types.encode("utf-8"),
        "_rels/.rels": rels.encode("utf-8"),
        "word/document.xml": document.encode("utf-8"),
    }

def write_docx(path, md_text):
    body = md_to_body(md_text)
    files = build_docx(body)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            zf.writestr(name, data)
    print("已生成:", path)

# ---------------------------------------------------------------
# 入口
# ---------------------------------------------------------------
TASKS = [
    ("PPT大纲.md", "ppt大纲.docx"),
    ("实验创新性分析报告.md", "实验创新型分析报告.docx"),
    ("芯片设计说明书.md", "芯片设计说明书.docx"),
]

if __name__ == "__main__":
    for src, dst in TASKS:
        sp = os.path.join(HERE, src)
        dp = os.path.join(HERE, dst)
        if os.path.exists(sp):
            with open(sp, "r", encoding="utf-8") as f:
                write_docx(dp, f.read())
        else:
            print("跳过(源不存在):", src)
