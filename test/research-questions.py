"""Exercise batch answers and same-session revisions from a delivery plan."""
from pathlib import Path
from runpy import run_path

from playwright.sync_api import expect


def check(page):
    helpers = run_path(str(Path(__file__).with_name("research-prototype.py")))
    helpers["open_issue_workbench"](page, with_questions=True)
    helpers["add_marked_to_plan"](page)
    page.get_by_role("button", name="方案调研").click()
    page.get_by_role("button", name="批量答疑（2）").click()
    panel = page.get_by_role("region", name="集中答疑", exact=True)
    first = panel.get_by_role("region", name="结算筛选")
    second = panel.get_by_role("region", name="附件回退")
    first.get_by_role("radio", name="推荐", exact=False).check()
    second.get_by_role("radio", name="自己补充").check()
    second.get_by_role("textbox").fill("附件缺失时保留正文，并验证附件回退。")
    panel.get_by_role("button", name="确认并发送答案", exact=False).click()
    first.get_by_role("button", name="查看方案 v2").wait_for()
    second.get_by_role("button", name="查看方案 v2").click()
    preview = page.get_by_role("region", name="方案预览")
    expect(preview.locator("article").first).to_contain_text("验证附件回退")
    first.get_by_role("button", name="查看方案 v2").click()
    expect(preview.locator("article").first).to_contain_text("使用推荐方案")
    expect(preview.locator("article").first).not_to_contain_text("验证附件回退")
