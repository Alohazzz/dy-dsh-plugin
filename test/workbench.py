"""DSH browser regression for the workbench and local skill catalog."""

from pathlib import Path
from tempfile import TemporaryDirectory

from playwright.sync_api import expect


def check(page):
    entry = page.get_by_role("button", name="研发工作台", exact=True)
    collapsed = page.get_by_role("button", name="打开侧边栏", exact=True)
    entry.or_(collapsed).first.wait_for(state="visible")
    if collapsed.is_visible():
        collapsed.click()
    entry.click()
    expect(page.get_by_role("heading", name="研发工作台")).to_be_visible()
    expect(page.get_by_role("heading", name="云效议题", exact=True)).to_be_visible()
    page.get_by_role("button", name="连接设置", exact=True).click()
    connection = page.get_by_role("dialog", name="云效连接设置")
    expect(connection.get_by_role("button", name="保存并连接")).to_be_disabled()
    connection.get_by_role("button", name="关闭").click()

    page.get_by_role("button", name="技能管理", exact=True).click()
    expect(page.get_by_text("尚未绑定技能源。")).to_be_visible()
    with TemporaryDirectory() as directory:
        root = Path(directory)
        definition = root / "SKILL.md"
        definition.write_text("---\nname: Review\ndescription: Sample\n---\n## Original", encoding="utf-8")
        (root / "check.ps1").touch()
        page.get_by_role("button", name="添加本地目录").click()
        form = page.get_by_role("dialog", name="添加本地目录")
        form.get_by_label("来源名称").fill("本地开发")
        form.get_by_label("本地目录").fill(str(root / "missing"))
        form.get_by_role("button", name="绑定并读取").click()
        expect(form.get_by_role("alert")).to_be_visible()
        expect(form.get_by_label("本地目录")).to_have_value(str(root / "missing"))
        form.get_by_label("本地目录").fill(directory)
        form.get_by_role("button", name="绑定并读取").click()
        expect(form).to_have_count(0)

        search = page.get_by_role("searchbox", name="搜索技能")
        search.fill("sample")
        page.get_by_role("button", name="Review 未安装 Sample").click()
        expect(page.get_by_role("heading", name="Original")).to_be_visible()
        expect(search).to_be_visible()
        page.get_by_role("button", name="安装到…").click()
        installation = page.get_by_role("dialog", name="安装技能")
        select = installation.get_by_label("安装目标")
        expect(select.locator("option[value='agent:.dsh']")).to_have_text(".dsh Agent（实例共享）")
        expect(select.locator("optgroup[label='项目']")).to_have_count(0)
        installation.get_by_role("button", name="取消").click()

        page.set_viewport_size({"width": 1920, "height": 900})
        page.emulate_media(color_scheme="dark")
        reader = page.get_by_role("region", name="技能详情")
        content = reader.get_by_role("heading", name="Original").bounding_box()
        status = reader.get_by_role("region", name="当前技能安装状态").bounding_box()
        install = reader.get_by_role("button", name="安装到…").bounding_box()
        assert content["x"] + content["width"] < status["x"]
        assert status["x"] < install["x"]

        page.get_by_role("button", name="配套文件（1）").click()
        expect(page.get_by_text("check.ps1", exact=True)).to_be_visible()
        page.set_viewport_size({"width": 600, "height": 720})
        file = reader.get_by_text("check.ps1", exact=True).bounding_box()
        status = reader.get_by_role("region", name="当前技能安装状态").bounding_box()
        assert status["y"] + status["height"] < file["y"]
        page.get_by_role("button", name="返回技能目录").click()
        expect(search).to_have_value("sample")

        definition.write_text("---\nname: Updated\ndescription: Sample\n---\n## New content", encoding="utf-8")
        page.get_by_role("button", name="刷新", exact=True).click()
        expect(page.get_by_role("button", name="Updated 未安装 Sample")).to_be_visible()
        page.get_by_role("button", name="云效议题", exact=True).click()
        page.get_by_role("button", name="技能管理", exact=True).click()
        expect(search).to_have_value("sample")

        page.reload()
        if not page.get_by_role("heading", name="研发工作台").is_visible():
            if collapsed.is_visible():
                collapsed.click()
            entry.click()
        expect(page.get_by_role("heading", name="技能管理", exact=True)).to_be_visible()
        expect(page.get_by_role("button", name="Updated 未安装 Sample")).to_be_visible()
        page.set_viewport_size({"width": 720, "height": 720})
        expect(page.get_by_role("button", name="添加本地目录")).to_be_in_viewport()
        expect(page.get_by_role("button", name="Updated 未安装 Sample")).to_be_in_viewport()
        page.get_by_role("button", name="解除绑定", exact=True).click()
        page.get_by_role("dialog", name="解除绑定").get_by_role("button", name="解除绑定", exact=True).click()
        expect(page.get_by_text("尚未绑定技能源。")).to_be_visible()
        assert definition.is_file()

    print("PASS | workbench navigation, Yunxiao settings, local source binding, detail, refresh and unbind")
