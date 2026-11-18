"""DSH browser scenario for the image viewer."""
from playwright.sync_api import expect


def check(page):
    row = dict(id="1", title="预览测试", reference="TEST-1", state=dict(name="处理中"))
    options = [dict(id="1", name="测试")]
    methods = dict(
        meta=dict(projects=options, workspaces=options, presets=[], permissions=[]),
        filters=dict(statuses=[], products=[], versions=[]),
        search=dict(rows=[row], more=False),
        detail=dict(**row, text="图片附件", files=[dict(name="sample.svg", url="/sample.svg", image=True)]),
    )
    page.route("**/api/dy-yunxiao", lambda r: r.fulfill(json=dict(value=methods[r.request.post_data_json["method"]])))
    page.route("**/sample.svg", lambda r: r.fulfill(content_type="image/svg+xml",
               body='<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="2600"><rect width="100%" height="100%" fill="silver"/></svg>'))
    page.get_by_role("button", name="云效议题", exact=True).click()
    page.get_by_role("button", name="预览测试", exact=True).click()
    detail = page.get_by_role("region", name="议题详情")
    for nested in [False, True]:
        region = detail
        if nested:
            detail.get_by_role("button", name="直接开工").click()
            region = page.get_by_role("dialog", name="直接开工")
            region.get_by_text("查看原文与附件").click()
        region.get_by_role("button", name="预览 sample.svg").click()
        viewer = page.get_by_role("dialog", name="图片预览")
        image = viewer.get_by_role("img")
        viewer.get_by_role("button", name="原始尺寸").click()
        expect(image).to_have_css("height", "2600px")
        viewer.get_by_role("button", name="适应窗口").click()
        assert image.bounding_box()["height"] < 2600
        page.keyboard.press("Escape")
        expect(viewer).to_be_hidden()
        expect(region).to_be_visible()
        region.get_by_role("button", name="sample.svg", exact=True).click()
        viewer.get_by_role("button", name="关闭预览").click()
        expect(viewer).to_be_hidden()
