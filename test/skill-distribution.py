"""Verify project and .dsh Agent distribution in an isolated DSH host."""

from os import environ
from pathlib import Path
from subprocess import check_output
from tempfile import TemporaryDirectory

from playwright.sync_api import expect


def check(page):
    def request(path, data):
        result = page.request.post(path, data=data)
        body = result.json()
        assert result.ok, body
        return body

    def rpc(method, **data):
        return request("/api/dy-yunxiao", {"method": method, "input": data})["value"]

    def fixture(**data):
        return request("/api/skill-distribution-fixture", data)

    with TemporaryDirectory() as temp:
        root = Path(temp)
        project = root / "project"
        other = root / "other"
        source = root / "source"
        for folder in (project, other, source):
            folder.mkdir()
        (project / ".git").mkdir()
        (other / ".git").mkdir()
        for skill in ("fixture-project-skill", "fixture-agent-skill"):
            folder = source / skill
            folder.mkdir()
            (folder / "SKILL.md").write_text(
                f"---\nname: {skill}\ndescription: Isolated acceptance fixture\n---\nRun probe.mjs.\n",
                encoding="utf-8",
            )
            (folder / "probe.mjs").write_text("console.log('fixture executed')\n", encoding="utf-8")
        workspace = fixture(setup={"project": str(project), "other": str(other)})
        first, second, outside = workspace["sessions"]
        assert len(set(workspace["sessions"])) == 3
        bound = rpc("bindSkillSource", kind="local", name="验收技能源", location=str(source))["source"]
        skill = next(item for item in bound["skills"] if item["name"] == "fixture-agent-skill")
        rejected = page.request.post("/api/dy-yunxiao", data={"method": "installSkill", "input": {
            "sourceId": bound["id"], "path": skill["path"], "readAt": skill["readAt"],
            "targetKind": "agent", "targetId": first,
        }})
        assert not rejected.ok

        composer = page.locator('[contenteditable="true"]:visible')

        def search_skill(query):
            composer.press("Control+a")
            composer.press("Backspace")
            composer.press_sequentially("/" + query)

        # Wait for the existing composer to cache its catalog before installing.
        search_skill("yunxiao-dsh")
        expect(page.get_by_role("option", name="yunxiao-dsh-execute", exact=False)).to_be_visible()
        rows = rpc("installSkill", sourceId=bound["id"], path=skill["path"], readAt=skill["readAt"],
                   targetKind="agent", targetId=".dsh")
        search_skill("fixture-agent")
        suggestion = page.get_by_role("option", name="fixture-agent-skill", exact=False)
        expect(suggestion).to_be_visible()
        suggestion.click()
        expect(composer).to_contain_text("/fixture-agent-skill")
        with page.expect_response(lambda response: response.url.endswith("/api/skills/list") and response.ok):
            rpc("uninstallSkill", id=rows[0]["id"])
            search_skill("yunxiao-dsh")
        expect(page.get_by_role("option", name="yunxiao-dsh-execute", exact=False)).to_be_visible()
        search_skill("fixture-agent")
        expect(suggestion).to_have_count(0)
        composer.press("Control+a")
        composer.press("Backspace")
        print("PASS | an open composer refreshes slash suggestions after install and uninstall")

        page.get_by_role("button", name="研发工作台", exact=True).click()
        page.get_by_role("button", name="技能管理", exact=True).click()

        def catalog_skill(name):
            return page.get_by_role("region", name="技能目录").get_by_role("button", name=name, exact=False)

        def assert_status(name, status):
            expect(catalog_skill(name).get_by_text(status, exact=True)).to_be_visible()

        def install(name, target):
            catalog_skill(name).click()
            page.get_by_role("button", name="安装到…").click()
            form = page.get_by_role("dialog", name="安装技能")
            select = form.get_by_label("安装目标")
            expect(select.locator("option")).to_have_count(4)
            assert set(select.locator("option").evaluate_all("(options) => options.map(option => option.value)")) == {
                "", "project:" + workspace["project"], "project:" + workspace["other"], "agent:.dsh",
            }
            select.select_option(value=target)
            form.get_by_role("button", name="确认安装").click()
            expect(form).to_have_count(0)

        def probe(name, session, cwd, expected):
            observed = fixture(name=name, session=session, cwd=str(cwd))
            assert observed["catalog"] == expected, observed
            assert ("content" in observed) == expected, observed
            if expected:
                assert "Run probe.mjs." in observed["content"]
                script = Path(observed["directory"]) / "probe.mjs"
                assert check_output(["node", str(script)], text=True).strip() == "fixture executed"

        assert_status("fixture-project-skill", "未安装")
        install("fixture-project-skill", "project:" + workspace["project"])
        assert_status("fixture-project-skill", "已安装 · 1")
        install("fixture-agent-skill", "agent:.dsh")
        assert_status("fixture-agent-skill", "已安装 · 1")
        for name, expected in (("fixture-project-skill", [True, True, False]), ("fixture-agent-skill", [True, True, True])):
            for session, cwd, visible in zip((first, second, outside), (project, project, other), expected):
                probe(name, session, cwd, visible)
        install("fixture-agent-skill", "project:" + workspace["project"])
        assert_status("fixture-agent-skill", "已安装 · 2")
        outside_installation = fixture(name="fixture-agent-skill", session=outside, cwd=str(other))
        project_installation = fixture(name="fixture-agent-skill", session=first, cwd=str(project))
        assert project_installation["directory"] != outside_installation["directory"]
        (Path(project_installation["directory"]) / "probe.mjs").unlink()
        page.get_by_role("button", name="已安装", exact=True).click()
        installed_section = page.get_by_role("region", name="已安装技能")
        expect(installed_section.get_by_text("文件缺失", exact=False)).to_have_count(1)
        page.get_by_role("button", name="技能目录", exact=True).click()
        assert_status("fixture-agent-skill", "文件缺失 · 1/2")
        catalog_skill("fixture-agent-skill").click()
        broken_installation = page.get_by_role("region", name="当前技能安装状态").get_by_role("listitem").filter(has_text="文件缺失")
        broken_installation.get_by_role("button", name="卸载", exact=False).click()
        page.get_by_role("dialog", name="卸载技能").get_by_role("button", name="确认卸载").click()
        assert_status("fixture-agent-skill", "已安装 · 1")

        page.get_by_role("button", name="已安装", exact=True).click()
        expect(page.get_by_role("region", name="已安装技能").get_by_text("验收技能源", exact=False)).to_have_count(2)
        for name in ("fixture-agent-skill", "fixture-project-skill"):
            page.get_by_role("button", name="卸载 " + name, exact=False).click()
            page.get_by_role("dialog", name="卸载技能").get_by_role("button", name="确认卸载").click()
            expect(page.get_by_role("dialog", name="卸载技能")).to_have_count(0)
            for session, cwd in ((first, project), (second, project), (outside, other)):
                probe(name, session, cwd, False)
        expect(page.get_by_role("region", name="已安装技能").get_by_text("未安装技能。", exact=True)).to_be_visible()
        page.get_by_role("button", name="技能目录", exact=True).click()
        assert_status("fixture-project-skill", "未安装")
        assert_status("fixture-agent-skill", "未安装")
        assert len(list(source.rglob("SKILL.md"))) == 2
        print("PASS | DSH catalogs scope project skills and share .dsh Agent skills, resources execute, uninstall invalidates discovery")

        if remote := environ.get("DY_SKILL_ACCEPTANCE_REMOTE"):
            company = rpc("bindSkillSource", kind="git", name="公司技能验收", location=remote)["source"]
            for path, kind, target in (
                ("yunxiao-issue-execution/SKILL.md", "project", workspace["project"]),
                ("merge-code-review/SKILL.md", "agent", ".dsh"),
            ):
                skill = next(item for item in company["skills"] if item["path"] == path)
                rows = rpc("installSkill", sourceId=company["id"], path=path, readAt=skill["readAt"],
                           targetKind=kind, targetId=target)
                row = next(item for item in rows if item["path"] == path)
                assert row["commit"] == skill["commit"]
                observed = fixture(name=skill["name"], session=first, cwd=str(project))
                assert observed["catalog"] and observed["content"].rstrip() == skill["markdown"].rstrip()
                directory = Path(observed["directory"])
                for file in skill["files"]:
                    assert (directory / file.removeprefix(path.removesuffix("SKILL.md"))).is_file()
                assert fixture(name=skill["name"], session=outside, cwd=str(other))["catalog"] == (kind == "agent")
                assert fixture(name=skill["name"], session=second, cwd=str(project))["catalog"]
                rpc("uninstallSkill", id=row["id"])
                assert not fixture(name=skill["name"], session=first, cwd=str(project))["catalog"]
            print("PASS | company Git skills loaded from pinned commit with companion files and removed")
