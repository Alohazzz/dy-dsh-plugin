from playwright.sync_api import expect

def check(page):
    entry=page.get_by_role("button",name="研发工作台",exact=True)
    folded=page.get_by_role("button",name="打开侧边栏",exact=True)
    entry.or_(folded).first.wait_for()
    if not entry.is_visible(): folded.click()
    entry.click()
    page.get_by_role("button",name="双议题调研原型").click()
    page.get_by_role("button",name="并行调研两个议题").click()
    page.get_by_role("button",name="集中答疑").click()
    panel=page.get_by_role("region",name="集中答疑",exact=True)
    groups=[panel.get_by_role("region",name=key,exact=False) for key in ("示例 A","示例 B")]
    for group in groups:
        expect(group.get_by_role("radio",name="推荐",exact=False).first).to_be_visible(timeout=320000)
    groups[0].get_by_role("radio",name="备选",exact=False).first.check()
    groups[0].get_by_role("radio",name="推荐",exact=False).first.check()
    groups[1].get_by_role("radio",name="自己补充").first.check()
    groups[1].get_by_role("textbox").first.fill("附件缺失时保留正文，在验收中加入“附件回退检查”。")
    submit=panel.get_by_role("button",name="确认并发送答案",exact=False)
    submit.click()
    for g in groups:
        expect(g.get_by_role("button",name="查看方案 v2")).to_be_visible(timeout=320000)
    groups[1].get_by_role("button",name="查看方案 v2").click()
    expect(page.locator("main section > article").first).to_contain_text("附件回退检查")
    expect(page.get_by_text("本轮意见",exact=False)).to_contain_text("确认答案")
    page.get_by_role("button",name="集中答疑").click()
    groups[0].get_by_role("button",name="查看方案 v2").click()
    expect(page.get_by_text("本轮意见",exact=False)).not_to_contain_text("附件回退检查")
    print("PASS | grouped choices, same-session per-issue routing, both previews auto-updated",flush=True)
