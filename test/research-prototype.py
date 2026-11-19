"""DSH Web acceptance for two independent research sessions and a same-session revision."""
from playwright.sync_api import expect

def check(page):
    entry = page.get_by_role("button", name="研发工作台", exact=True)
    collapsed = page.get_by_role("button", name="打开侧边栏", exact=True)
    entry.or_(collapsed).first.wait_for(state="visible")
    if not entry.is_visible():
        collapsed.click()
    entry.click()
    page.get_by_role("button", name="双议题调研原型").click()
    page.get_by_role("button", name="并行调研两个议题").click()
    a = page.get_by_role("button", name="示例 A ·", exact=False)
    b = page.get_by_role("button", name="示例 B ·", exact=False)
    expect(a).to_be_visible()
    expect(b).to_be_visible()
    expect(a).to_contain_text("待审核", timeout=320000)
    expect(b).to_contain_text("待审核", timeout=320000)
    preview = page.locator("main section > article").first
    first = preview.inner_text()
    sid = page.locator("main section small").inner_text()
    b.click()
    other = preview.inner_text()
    assert page.locator("main section small").inner_text() != sid
    a.click()
    page.get_by_label("给原 Agent 的修改意见").fill("请补充一个名为「重开验证」的具体验收场景，并保留原方案。")
    page.get_by_role("button", name="发送并修订").click()
    expect(page.get_by_role("status").filter(has_text="正在修订")).to_be_visible()
    expect(page.get_by_role("heading", name="方案预览 v2")).to_be_visible(timeout=320000)
    expect(preview).to_contain_text("重开验证")
    expect(page.get_by_role("status").filter(has_text="修订完成")).to_be_visible()
    page.get_by_text("查看上一版 · v1", exact=True).click()
    previous = page.locator("main details article")
    assert previous.inner_text() == first
    assert previous.locator("h1,h2,h3,strong,ul,ol,table").count() > 0
    textarea = page.get_by_label("给原 Agent 的修改意见")
    assert textarea.bounding_box()["width"] > page.locator(".dy-research-feedback").bounding_box()["width"] * .9
    assert preview.inner_text() != first
    assert page.locator("main section small").inner_text() == sid
    b.click()
    expect(page.get_by_role("heading", name="方案预览 v1")).to_be_visible()
    assert preview.inner_text() == other
    print("PASS | two independent drafts, A revised in its original session, B still v1", flush=True)
