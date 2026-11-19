"""Check a refreshed MR client attached to an older running DSH host."""

from playwright.sync_api import expect


def check(page):
    mr = dict(repositoryId=1, localId=1, title="审查兼容性", repository="sandbox",
              source="feature/test", target="main", status="TO_BE_MERGED", reviewers=[])
    supported = False
    review_reads = []

    def respond(route):
        method = route.request.post_data_json["method"]
        if method == "workbenchMrs":
            value = dict(rows=[mr], more=False)
        elif method == "workbenchMr":
            value = dict(mr=mr, plans=[], planError="")
            if supported:
                value["reviewSupported"] = True
        elif method == "mrReview":
            review_reads.append(method)
            if not supported:
                return route.fulfill(status=400, json=dict(error="未知云效操作"))
            value = dict(sources=[dict(id="skillhub", label="公司 SkillHub")])
        else:
            return route.continue_()
        route.fulfill(json=dict(value=value))

    page.route("**/api/dy-yunxiao", respond)
    entry = page.get_by_role("button", name="研发工作台", exact=True)
    collapsed = page.get_by_role("button", name="打开侧边栏", exact=True)
    entry.or_(collapsed).first.wait_for(state="visible")
    if collapsed.is_visible():
        collapsed.click()
    entry.click()
    page.get_by_role("navigation", name="研发工作台模块").get_by_role("button", name="合并请求").click()
    page.get_by_role("button", name="!1 审查兼容性").click()
    review = page.get_by_role("region", name="AI 合并审查")
    expect(review.get_by_role("status")).to_contain_text("当前 DSH 宿主尚未加载审查接口")
    expect(review.get_by_role("button", name="拉取 MR 到本地")).to_have_count(0)
    assert not review_reads

    supported = True
    with page.expect_response(lambda response: response.url.endswith("/api/dy-yunxiao")
                              and response.request.post_data_json.get("method") == "mrReview"):
        page.get_by_role("button", name="刷新", exact=True).click()
    expect(review.get_by_role("button", name="拉取 MR 到本地")).to_be_enabled()
    expect(review.get_by_role("button", name="运行只读审查")).to_be_disabled()
    assert review_reads == ["mrReview"]
    print("PASS | old host shows recovery instructions and the refreshed new host enables review")
