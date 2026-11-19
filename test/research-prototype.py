"""Exercise the issue workflow in an isolated DSH Web host."""
from playwright.sync_api import expect


def open_issue_workbench(page, with_questions=False, execution=None):
    scope = dict(project="project", workspaceId="w", planId="plan")
    plan = dict(id="plan", name="交付计划 A", branch="dev", end="2026-11-30", members=[])
    options = dict(projects=[dict(id="project", name="测试项目")],
                   workspaces=[dict(id="w", name="测试工作区")])
    issues = [dict(id=f"issue-{i}", reference=f"TEST-{i}", title=title, project="project",
                   owner="", state=dict(id="todo", name="待开发"), url="")
              for i, title in enumerate(("结算筛选", "附件回退"), start=1)]
    plan_row = dict(**scope, plan=plan, projectName="测试项目", workspaceName="测试工作区")
    rows = []
    executions = []

    def respond(route):
        request = route.request.post_data_json
        method, args = request["method"], request.get("input", {})
        if method == "meta":
            value = dict(**options, presets=[], permissions=[], organization="org", user="测试")
        elif method == "filters":
            value = dict(statuses=[], products=[], versions=[])
        elif method in ("search", "detail"):
            listed = [dict(issue, **(dict(plan=plan["name"], planId=plan["id"]) if issue["id"] in plan["members"] else {}))
                      for issue in issues]
            value = (dict(rows=listed, more=False) if method == "search" else
                     dict(next(issue for issue in listed if issue["id"] == args["id"]), body=[], files=[]))
        elif method == "plans":
            value = [plan]
        elif method == "addToPlan":
            assert args["planId"] == plan["id"]
            plan["members"] = args["ids"]
            value = [dict(id=id, result="成功") for id in plan["members"]]
        elif method == "workbenchPlans":
            value = [plan_row]
        elif method == "workbenchPlan":
            planned = [dict(issue) for issue in issues if issue["id"] in plan["members"]]
            value = dict(plan=plan, issues=planned, candidates=[])
            if execution and execution["supported"]:
                value["executionSupported"] = True
                first = next((issue for issue in planned if issue["id"] == "issue-1"), None)
                if first and len(executions) == 1:
                    first["executionVersion"] = 1
                if first and len(executions) == 2:
                    first["sessionId"] = "example-execution"
        elif method == "planResearch":
            if args.get("start"):
                questions = [dict(question="如何验收？", recommended="使用推荐方案", alternatives=["补充用例"])] if with_questions else []
                rows.extend(dict(issueId=issue["id"], title=issue["title"], sessionId="research-" + issue["id"],
                                 status="ready", drafts=[dict(markdown="## 初版方案", feedback="", questions=questions)])
                            for issue in issues if issue["id"] in plan["members"])
            value = dict(batchId="batch", rows=rows)
        elif method == "researchStatus":
            value = rows
        elif method == "researchSummaries":
            value = []
            for row in rows:
                version = len(row["drafts"])
                count = len(row["drafts"][-1]["questions"])
                finalized = row.get("finalizedVersion") == version
                value.append(dict(issueId=row["issueId"], sessionId=row["sessionId"], version=version, count=count,
                                  canFinalize=not (count or finalized),
                                  label="已定稿" if finalized else "待答疑" if count else "无待确认事项"))
        elif method in ("researchFinalize", "researchRevise"):
            row = next(row for row in rows if row["sessionId"] == args["sessionId"])
            assert args["version"] == len(row["drafts"])
            if method == "researchFinalize":
                assert not row["drafts"][-1]["questions"]
                row["finalizedVersion"] = args["version"]
                value = dict(issueId=row["issueId"], sessionId=row["sessionId"], version=args["version"],
                             canFinalize=False, label="已定稿", count=0)
            else:
                row["drafts"].append(dict(markdown="## 修订方案\n\n" + args["feedback"], feedback=args["feedback"], questions=[]))
                value = row
        elif method == "executePlanIssue":
            assert args == dict(**scope, id="issue-1", version=1)
            assert rows[0]["finalizedVersion"] == 1
            executions.append(args)
            if len(executions) == 1:
                return route.fulfill(status=400, json=dict(error="派发中断"))
            value = dict(sessionId="example-execution")
        else:
            raise AssertionError(method)
        route.fulfill(json=dict(value=value))

    page.route("**/api/dy-yunxiao", respond)
    entry = page.get_by_role("button", name="研发工作台", exact=True)
    collapsed = page.get_by_role("button", name="打开侧边栏", exact=True)
    entry.or_(collapsed).first.wait_for(state="visible")
    if not entry.is_visible():
        collapsed.click()
    entry.click()
    return executions


def add_marked_to_plan(page):
    for ref in ("TEST-1", "TEST-2"):
        page.get_by_role("checkbox", name=f"勾选 {ref}").check()
    expect(page.get_by_role("button", name="发起讨论")).to_have_count(0)
    page.get_by_role("button", name="添加到计划", exact=True).click()
    dialog = page.get_by_role("dialog", name="添加到计划")
    dialog.get_by_role("button", name="确认加入").click()
    expect(dialog.get_by_text("TEST-2 · 成功")).to_be_visible()
    dialog.get_by_role("button", name="返回", exact=True).click()
    page.get_by_role("button", name="结算筛选", exact=True).click()
    page.get_by_role("button", name="查看交付计划").click()


def check(page):
    execution = dict(supported=False)
    executions = open_issue_workbench(page, execution=execution)
    expect(page.get_by_role("button", name="双议题调研原型")).to_have_count(0)
    page.get_by_role("button", name="结算筛选", exact=True).click()
    detail = page.get_by_role("region", name="议题详情")
    expect(detail.get_by_role("button", name="添加到计划")).to_be_visible()
    expect(page.get_by_role("button", name="直接开工")).to_have_count(0)
    add_marked_to_plan(page)
    desktop = page.get_by_role("region", name="计划议题")
    expect(desktop.get_by_role("button", name="开始执行")).to_have_count(0)
    desktop.get_by_role("button", name="方案调研").click()
    issue = desktop.get_by_role("row").filter(has_text="TEST-1")
    expect(issue.get_by_role("button", name="查看 v1")).to_be_visible()
    expect(desktop.get_by_role("button", name="开始执行")).to_have_count(0)
    issue.get_by_role("button", name="标记定稿").click()
    expect(issue.get_by_role("button", name="开始执行")).to_be_disabled()
    expect(desktop.get_by_text("请更新研发工作台插件并重启 DSH，再开始执行。")).to_be_visible()
    assert not executions
    execution["supported"] = True
    page.get_by_role("button", name="刷新", exact=True).click()
    issue.get_by_role("button", name="开始执行").click()
    expect(desktop.get_by_role("alert")).to_have_text("派发中断")
    with page.expect_response(lambda response: response.request.post_data_json and
                              response.request.post_data_json.get("method") == "executePlanIssue"):
        issue.get_by_role("button", name="重试执行 v1").click()
    assert len(executions) == 2
    entry = page.get_by_role("button", name="研发工作台", exact=True)
    entry.click()
    expect(issue.get_by_role("button", name="查看执行会话")).to_be_visible()
