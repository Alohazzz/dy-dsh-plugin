"""Exercise plan and MR entry points against an isolated DSH Web host."""
from playwright.sync_api import expect


def check(page):
    rows = [dict(key=key, name=name, branch=branch, sha='a'*40, upstream='', ahead=0, behind=0, dirty=0, error='')
            for key, name, branch in [('.', 'HIS', 'root-fix'), ('Nto.His/Term', 'Term', 'term-fix')]]
    submissions = []
    detail_reads = []
    binding = dict(key='Nto.His/Term', repositoryId=2, path='org/Term', target='release')
    plans = {
        'legacy': dict(id='legacy', name='结算导出计划', branch='root-fix', end='2026-11-24', members=['issue1']),
        'term': dict(id='term', name='术语缓存计划', branch='term-fix', end='2026-11-26', members=[], delivery=binding),
    }

    def plan_row(plan):
        return dict(plan=plan, planId=plan['id'], project='project', projectName='HIS 项目',
                    workspaceId='w', workspaceName='HIS', mrStatus='UNDER_REVIEW' if (plan.get('delivery') or {}).get('mr') else '')

    def mr_row(repo, local_id):
        return dict(repositoryId=repo, localId=local_id, title='刷新术语缓存' if repo == 2 else '结算导出修正',
                    url='https://codeup.aliyun.com/test', repository='org/Term' if repo == 2 else 'org/HIS',
                    source='term-fix' if repo == 2 else 'root-fix', target='release' if repo == 2 else 'main',
                    author='开发者', status='UNDER_REVIEW', description='变更说明示例',
                    reviewers=[dict(id='me', name='苏一', reviewed=False)])

    def respond(route):
        data = route.request.post_data_json
        method, args = data['method'], data.get('input', {})
        if method == 'meta':
            value = dict(projects=[dict(id='project', name='HIS 项目')], workspaces=[dict(id='w', name='HIS')],
                         organization='org', user='苏一', presets=[], permissions=[])
        elif method == 'mrRepos':
            value = rows
        elif method == 'mrPreview':
            sub = args['key'] != '.'
            value = dict(**rows[int(sub)], repository=dict(path='org/' + rows[int(sub)]['name'], id=1+int(sub), defaultBranch='main'),
                         remoteSha='' if sub else 'a'*40, targets=['main','release'], blocked='', needPush=sub, commits=[], openMrs=[])
        elif method == 'submitMr':
            submissions.append(args)
            value = dict(localId=5, url='https://codeup.aliyun.com/test', existing=False, pushed=args['needPush'])
        elif method == 'workbenchPlans':
            value = [plan_row(plan) for plan in plans.values()]
        elif method == 'workbenchPlan':
            plan = plans[args['planId']]
            candidates = [dict(localId=5, title='刷新术语缓存', target='release', url='')] if plan['id'] == 'term' and not binding.get('mr') else []
            issues = [dict(id='issue1', reference='HSP-2086', title='结算导出时保留筛选条件',
                           owner='苏一', state=dict(id='doing', name='开发中'), url='')] if plan['members'] else []
            value = dict(plan=plan, candidates=candidates, issues=issues, mrStatus=plan_row(plan)['mrStatus'])
        elif method == 'planDeliveryOptions':
            value = dict(repository=dict(path='org/HIS', id=1, defaultBranch='main'), targets=['main'])
        elif method == 'bindPlanDelivery':
            value = dict(key=args['key'], repositoryId=args['repositoryId'], path='org/HIS', target=args['target'])
            plans[args['planId']]['delivery'] = value
        elif method == 'linkPlanMr':
            binding['mr'] = {key: args[key] for key in ('repositoryId', 'localId')}
            value = binding
        elif method == 'submitPlanMr':
            submissions.append(args)
            value = dict(repositoryId=args['repositoryId'], localId=5)
            plans[args['planId']]['delivery']['mr'] = value
        elif method == 'workbenchMrs':
            value = dict(rows=[mr_row(2, 5)] if args['queue'] == 'review' else [], more=False, user='苏一')
        elif method == 'workbenchMr':
            ref = args['repositoryId'], args['localId']
            detail_reads.append(ref)
            related = [plan_row(plan) for plan in plans.values()
                       if (plan.get('delivery') or {}).get('mr') == dict(repositoryId=ref[0], localId=ref[1])]
            value = dict(mr=mr_row(*ref), plans=related, planError='')
        else:
            return route.continue_()
        route.fulfill(json=dict(value=value))

    page.route('**/api/dy-yunxiao', respond)
    page.get_by_role('button', name='研发工作台', exact=True).click()
    page.get_by_role('button', name='交付计划', exact=True).click()
    page.get_by_role('searchbox', name='搜索交付计划').fill('结算')
    page.get_by_role('button', name='结算导出计划').click()
    expect(page.get_by_text('HSP-2086', exact=True)).to_be_visible()
    page.get_by_role('button', name='配置交付分支').click()
    drawer = page.get_by_role('dialog', name='配置交付分支')
    drawer.get_by_label('目标分支').select_option('main')
    drawer.get_by_role('button', name='保存交付分支').click()
    page.get_by_role('button', name='发起合并请求', exact=True).click()
    drawer = page.get_by_role('dialog', name='发起合并请求')
    expect(drawer.get_by_label('合并请求标题')).to_have_value('结算导出计划')
    drawer.get_by_role('button', name='创建合并请求', exact=True).click()
    expect(page.get_by_text('已关联计划与 MR !5')).to_be_visible()
    assert (submissions[0]['key'], submissions[0]['branch'], submissions[0]['target']) == ('.', 'root-fix', 'main')
    page.get_by_role('button', name='查看 MR !5').click()
    expect(page.get_by_role('heading', name='!5 结算导出修正')).to_be_visible()
    page.get_by_role('button', name='返回计划', exact=True).click()
    page.get_by_role('button', name='返回交付计划', exact=True).click()
    expect(page.get_by_role('searchbox', name='搜索交付计划')).to_have_value('结算')
    page.get_by_role('searchbox', name='搜索交付计划').fill('')
    page.set_viewport_size(dict(width=640, height=760))
    page.emulate_media(color_scheme='dark')
    page.get_by_role('button', name='术语缓存计划').click()
    associate = page.get_by_role('button', name='关联已有 MR')
    expect(associate).to_be_in_viewport()
    associate.click()
    drawer = page.get_by_role('dialog', name='关联已有 MR')
    expect(drawer.get_by_role('radio', name='!5 刷新术语缓存')).to_be_checked()
    expect(drawer.get_by_role('button', name='确认关联')).to_be_in_viewport()
    drawer.get_by_role('button', name='确认关联').click()
    page.get_by_role('button', name='查看 MR !5').click()
    expect(page.get_by_role('heading', name='!5 刷新术语缓存')).to_be_visible()
    page.get_by_role('button', name='返回计划', exact=True).click()
    page.get_by_role('button', name='合并请求', exact=True).click()
    page.get_by_role('button', name='待我审核', exact=True).click()
    page.get_by_role('button', name='!5 刷新术语缓存', exact=True).click()
    expect(page.get_by_role('heading', name='!5 刷新术语缓存')).to_be_visible()
    expect(page.get_by_role('button', name='术语缓存计划')).to_be_visible()
    assert detail_reads == [(1, 5), (2, 5), (2, 5)]
    page.get_by_role('button', name='返回待我审核', exact=True).click()
    expect(page.get_by_role('button', name='待我审核', exact=True)).to_have_attribute('aria-current', 'page')

    page.get_by_role('button', name='发起合并请求', exact=True).click()
    main = page.get_by_role('region', name='发起合并请求', exact=True)
    expect(main.get_by_role('button', name='创建合并请求', exact=True)).to_be_enabled()
    main.get_by_label('合并请求标题').fill('主仓草稿')
    sub = main.get_by_role('button', name='Term 子仓库', exact=False)
    sub.click()
    main.get_by_label('合并请求标题').fill('子仓草稿')
    main.get_by_label('目标分支').select_option('release')
    main.get_by_role('button', name='HIS 主仓库', exact=False).click()
    expect(main.get_by_label('合并请求标题')).to_have_value('主仓草稿')
    sub.click()
    expect(main.get_by_label('目标分支')).to_have_value('release')
    page.set_viewport_size(dict(width=700,height=750))
    page.emulate_media(color_scheme='dark')
    main.get_by_role('button', name='推送并创建合并请求', exact=True).click()
    expect(main.get_by_role('link', name='查看 MR !5')).to_be_visible()
    assert len(submissions) == 2
    assert (submissions[-1]['key'], submissions[-1]['title'], submissions[-1]['target']) == ('Nto.His/Term','子仓草稿','release')
    print('PASS | plan list, legacy binding, scoped MR creation, existing MR association, shared detail and standalone MR')
