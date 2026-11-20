"""Exercise plan and MR entry points against an isolated DSH Web host."""
from playwright.sync_api import expect


def check(page):
    rows = [dict(key=key, name=name, branch=branch, sha='a'*40, upstream='', ahead=0, behind=0, dirty=0, error='')
            for key, name, branch in [('.', 'HIS', 'root-fix'), ('Nto.His/Term', 'Term', 'term-fix')]]
    submissions = []
    creations = []
    detail_reads = []
    removals = []
    reports = {}
    mr_states = {1: 'UNDER_REVIEW', 2: 'UNDER_REVIEW'}
    actions = []
    binding = dict(key='Nto.His/Term', repositoryId=2, path='org/Term', target='release')
    plans = {
        'legacy': dict(id='legacy', name='结算导出计划', branch='root-fix', end='2026-11-24', members=['issue1']),
        'term': dict(id='term', name='术语缓存计划', branch='term-fix', end='2026-11-26', members=[], delivery=binding),
    }

    def plan_row(plan):
        return dict(plan=plan, planId=plan['id'], project='project', projectName='HIS 项目',
                    workspaceId='w', workspaceName='HIS',
                    mrStatus=mr_states[(plan['delivery']['mr']['repositoryId'])] if (plan.get('delivery') or {}).get('mr') else '')

    def mr_row(repo, local_id):
        return dict(repositoryId=repo, localId=local_id, title='刷新术语缓存' if repo == 2 else '结算导出修正',
                    url='https://codeup.aliyun.com/test', repository='org/Term' if repo == 2 else 'org/HIS',
                    source='term-fix' if repo == 2 else 'root-fix', target='release' if repo == 2 else 'main',
                    author='开发者', status=mr_states[repo], description='变更说明示例',
                    mergedRevision='b'*40 if mr_states[repo] == 'MERGED' else '',
                    reviewers=[dict(id='me', name='苏一', reviewed=mr_states[repo] == 'TO_BE_MERGED',
                                    opinion='PASS' if mr_states[repo] == 'TO_BE_MERGED' else '')])

    def respond(route):
        data = route.request.post_data_json
        method, args = data['method'], data.get('input', {})
        if method == 'meta':
            value = dict(projects=[dict(id='project', name='HIS 项目')], workspaces=[dict(id='w', name='HIS')],
                         organization='org', user='苏一', presets=[], permissions=[])
        elif method == 'mrRepos':
            value = rows
        elif method == 'planRepositories':
            value = dict(repositories=rows, worktreeDir=r'H:\Project\HIS-worktrees')
        elif method == 'planVersions':
            value = [dict(id='v1', name='v2.20260901.0')]
        elif method == 'filters':
            value = dict(statuses=[], versions=[], products=[])
        elif method == 'search':
            value = dict(rows=[], more=False)
        elif method == 'checkPlanBranch':
            assert args['repositoryKey'] == 'Nto.His/Term'
            assert args['branch'] == 'fix/v2.20260901/release/术语复核'
            value = dict(localExists=False, remoteExists=True)
        elif method == 'createPlan':
            creations.append(args)
            plan = dict(id='created', members=[], repositoryKey=args['repositoryKey'],
                        worktree=args['worktreeDir'] + r'\created',
                        **{key: args[key] for key in ('name', 'kind', 'branch', 'end', 'baseBranch', 'targetBranch')})
            plans['created'] = value = plan
        elif method in ('mrPreview', 'planMrPreview'):
            key = args['key'] if method == 'mrPreview' else plans[args['planId']]['delivery']['key']
            sub = key != '.'
            value = dict(**rows[int(sub)], repository=dict(path='org/' + rows[int(sub)]['name'], id=1+int(sub), defaultBranch='main'),
                         remoteSha='' if sub else 'a'*40, targets=['main','release'], blocked='', needPush=sub, commits=[], openMrs=[])
        elif method == 'mrReviewerCandidates':
            if args['repositoryId'] == 1:
                value = [dict(id='root', name='主仓成员')]
            elif args['target'] == 'main':
                value = [dict(id='first', name='成员甲')]
            else:
                assert args['target'] == 'release'
                value = [dict(id='second', name='成员乙')]
        elif method == 'submitMr':
            submissions.append(args)
            value = dict(localId=5, url='https://codeup.aliyun.com/test', existing=False, pushed=args['needPush'])
        elif method == 'workbenchPlans':
            value = [plan_row(plan) for plan in plans.values()]
        elif method == 'voidPlan':
            assert args == dict(project='project', workspaceId='w', planId='created')
            plans['created']['voidedAt'] = '2026-11-20T03:00:00Z'
            value = dict(voidedAt=plans['created']['voidedAt'])
        elif method == 'workbenchPlan':
            plan = plans[args['planId']]
            candidates = [dict(localId=5, title='刷新术语缓存', target='release', url='')] if plan['id'] == 'term' and not binding.get('mr') else []
            issues = [dict(id='issue1', reference='HSP-2086', title='结算导出时保留筛选条件',
                           owner='苏一', state=dict(id='doing', name='开发中'), url='')] if plan['members'] else []
            value = dict(plan=plan, candidates=candidates, issues=issues, mrStatus=plan_row(plan)['mrStatus'])
        elif method == 'removeFromPlan':
            assert args == dict(project='project', workspaceId='w', planId='legacy', id='issue1', reason='移入后续计划', defer=False)
            removals.append(args)
            if len(removals) == 1:
                return route.fulfill(status=400, json=dict(error='云效暂时不可用'))
            plans['legacy']['members'].remove(args['id'])
            value = dict(removed=True)
        elif method == 'planCompletion':
            saved = reports.get(args['planId'], [])
            value = dict(reports=saved)
            if saved:
                value.update(latest=saved[-1], markdown='# 计划完成报告\n\n## 交付概况\n\n测试回写待核实\n\n'
                             '| 议题 | 依据 |\n| --- | --- |\n| E2E-1 | [执行小结](issues/execution.md) |')
        elif method == 'updatePlanCompletion':
            saved = reports.setdefault(args['planId'], [])
            version = len(saved) + 1
            value = dict(reportStatus=args['action'], version=version, file=f'completion-v{version}.md', time='2026-11-20T03:00:00Z')
            saved.append(value)
        elif method == 'planDeliveryOptions':
            value = (dict(repository=dict(path='org/Term', id=2, defaultBranch='release'), targets=['release'])
                     if args['planId'] == 'created' else
                     dict(repository=dict(path='org/HIS', id=1, defaultBranch='main'), targets=['main']))
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
            available = dict(UNDER_REVIEW=['approve', 'close'], TO_BE_MERGED=['merge', 'close'])
            value = dict(mr=mr_row(*ref), plans=related, planError='', actions=available.get(mr_states[ref[0]], []))
        elif method == 'previewMrAction':
            mr = mr_row(args['repositoryId'], args['localId'])
            value = dict(scope='scope', token='preview', actor='苏一', title=mr['title'], source=mr['source'],
                         target=mr['target'], patch=dict(version=2, sha='a'*40), fastForward=True)
        elif method == 'submitMrAction':
            assert args['token'] == 'preview' and args['scope'] == 'scope'
            actions.append(args['action'])
            if args['action'] == 'merge':
                assert args['mergeType'] == 'no-fast-forward'
                value = dict(confirmed=False)
            else:
                mr_states[args['repositoryId']] = 'TO_BE_MERGED' if args['action'] == 'approve' else 'CLOSED'
                value = dict(confirmed=True)
        elif method == 'checkMrAction':
            assert args == dict(repositoryId=2, localId=5, action='merge', scope='scope')
            actions.append('check')
            mr_states[2] = 'MERGED'
            value = dict(confirmed=True)
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
    drawer.get_by_label('审核人（选填）').select_option('root')
    drawer.get_by_role('button', name='创建合并请求', exact=True).click()
    expect(page.get_by_text('已关联计划与 MR !5')).to_be_visible()
    assert submissions[0]['reviewerUserIds'] == ['root']
    assert (submissions[0]['key'], submissions[0]['branch'], submissions[0]['target']) == ('.', 'root-fix', 'main')
    page.get_by_role('button', name='查看 MR !5').click()
    expect(page.get_by_role('heading', name='!5 结算导出修正')).to_be_visible()
    page.get_by_role('button', name='返回计划', exact=True).click()
    page.set_viewport_size(dict(width=420, height=680))
    page.emulate_media(color_scheme='dark')
    remove = page.get_by_role('button', name='移出计划 HSP-2086')
    remove.click()
    confirmation = page.get_by_role('dialog', name='调整议题范围', exact=True)
    expect(confirmation).to_contain_text('清空')
    confirmation.get_by_role('button', name='取消', exact=True).click()
    assert not removals
    remove.click()
    confirm = confirmation.get_by_role('button', name='确认移出')
    expect(confirm).to_be_disabled()
    confirmation.get_by_label('原因').fill('移入后续计划')
    expect(confirm).to_be_in_viewport()
    confirm.click()
    expect(confirmation.get_by_role('alert')).to_contain_text('云效暂时不可用')
    confirm.click()
    expect(page.get_by_text('暂无计划议题', exact=True)).to_be_visible()
    assert len(removals) == 2
    page.set_viewport_size(dict(width=1000, height=760))
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
    report = page.get_by_role('region', name='计划完成报告', exact=True)
    report.get_by_role('button', name='生成报告草稿').click()
    report.get_by_role('button', name='查看当前报告').click()
    report_dialog = page.get_by_role('dialog', name='计划完成报告', exact=True)
    expect(report_dialog.get_by_role('heading', name='交付概况')).to_be_visible()
    expect(report_dialog.get_by_text('测试回写待核实')).to_be_visible()
    expect(report_dialog.get_by_role('table').get_by_role('cell', name='执行小结')).to_be_visible()
    report_dialog.get_by_role('button', name='关闭', exact=True).click()
    expect(report_dialog).to_have_count(0)
    report.get_by_role('button', name='确认审核').click()
    review = page.get_by_role('dialog', name='确认计划报告')
    review.get_by_label('审核意见').fill('核对完毕')
    review.get_by_role('button', name='确认', exact=True).click()
    expect(report.get_by_text('v2 · 已审核')).to_be_visible()
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
    main.get_by_label('审核人（选填）').select_option('first')
    main.get_by_label('目标分支').select_option('release')
    main.get_by_label('审核人（选填）').select_option('second')
    expect(main.get_by_role('button', name='移除审核人 成员甲')).to_have_count(0)
    main.get_by_role('button', name='HIS 主仓库', exact=False).click()
    expect(main.get_by_label('合并请求标题')).to_have_value('主仓草稿')
    expect(main.get_by_role('button', name='移除审核人 成员乙')).to_have_count(0)
    sub.click()
    expect(main.get_by_label('目标分支')).to_have_value('release')
    page.set_viewport_size(dict(width=700,height=750))
    page.emulate_media(color_scheme='dark')
    main.get_by_role('button', name='推送并创建合并请求', exact=True).click()
    expect(main.get_by_role('link', name='查看 MR !5')).to_be_visible()
    assert len(submissions) == 2
    assert submissions[-1]['reviewerUserIds'] == ['second']
    assert (submissions[-1]['key'], submissions[-1]['title'], submissions[-1]['target']) == ('Nto.His/Term','子仓草稿','release')
    page.get_by_role('button', name='交付计划', exact=True).click()
    if page.get_by_role('button', name='返回交付计划', exact=True).is_visible():
        page.get_by_role('button', name='返回交付计划', exact=True).click()
    page.set_viewport_size(dict(width=420, height=680))
    page.get_by_role('button', name='创建计划', exact=True).click()
    plan_dialog = page.get_by_role('dialog', name='创建计划')
    plan_dialog.get_by_label('目标仓库').select_option('Nto.His/Term')
    expect(plan_dialog.get_by_label('基础分支')).to_have_value('term-fix')
    plan_dialog.get_by_label('计划名称').fill('术语复核')
    plan_dialog.get_by_role('button', name='fix · 缺陷修复', exact=True).click()
    plan_dialog.get_by_label('选择云效版本').select_option('v2.20260901')
    plan_dialog.get_by_label('合并回目标分支').fill('release')
    source = plan_dialog.get_by_label('源分支')
    expect(source).to_have_value('fix/v2.20260901/release/术语复核')
    source.fill('fix/manual')
    expect(source).to_have_value('fix/manual')
    plan_dialog.get_by_label('计划名称').fill('术语复核改')
    plan_dialog.get_by_label('计划名称').fill('术语复核')
    plan_dialog.get_by_role('button', name='检测', exact=True).click()
    expect(plan_dialog.get_by_role('button', name='创建计划 + 分支', exact=True)).to_be_disabled()
    plan_dialog.get_by_role('button', name='继续使用远端分支').click()
    plan_dialog.get_by_label('另建 worktree').check()
    expect(plan_dialog.get_by_label('代码目录')).to_have_value(r'H:\Project\HIS-worktrees')
    plan_dialog.get_by_label('计划完成时间').fill('2026-11-24')
    plan_dialog.get_by_role('button', name='创建计划 + 分支 + worktree', exact=True).click()
    expect(page.get_by_role('heading', name='术语复核', exact=True)).to_be_visible()
    assert len(creations) == 1 and creations[0]['useExistingRemote']
    assert (creations[0]['baseBranch'], creations[0]['targetBranch'], creations[0]['end']) == ('term-fix', 'release', '2026-11-24')
    page.get_by_role('button', name='配置交付分支').click()
    delivery_dialog = page.get_by_role('dialog', name='配置交付分支')
    expect(delivery_dialog.get_by_label('目标分支')).to_have_value('release')
    delivery_dialog.get_by_role('button', name='取消').click()
    page.get_by_role('button', name='云效议题', exact=True).click()
    page.get_by_role('button', name='创建计划', exact=True).click()
    expect(plan_dialog.get_by_label('目标仓库')).to_have_value('.')
    expect(plan_dialog.get_by_label('基础分支')).to_have_value('root-fix')
    plan_dialog.get_by_role('button', name='取消').click()

    page.get_by_role('button', name='交付计划', exact=True).click()
    if page.get_by_role('button', name='返回交付计划', exact=True).is_visible():
        page.get_by_role('button', name='返回交付计划', exact=True).click()
    page.get_by_role('button', name='术语缓存计划', exact=True).click()
    page.get_by_role('button', name='查看 MR !5').click()
    page.get_by_role('button', name='批准', exact=True).click()
    approval = page.get_by_role('dialog', name='批准', exact=True)
    expect(approval).to_contain_text('源补丁集 v2')
    approval.get_by_role('button', name='取消').click()
    assert not actions
    page.get_by_role('button', name='批准', exact=True).click()
    approval.get_by_role('button', name='确认批准').click()
    expect(page.get_by_text('苏一（已批准）')).to_be_visible()
    page.get_by_role('button', name='合并', exact=True).click()
    merge = page.get_by_role('dialog', name='合并', exact=True)
    confirm_merge = merge.get_by_role('button', name='确认合并')
    expect(confirm_merge).to_be_disabled()
    merge.get_by_label('合并方式').select_option('no-fast-forward')
    expect(confirm_merge).to_be_in_viewport()
    confirm_merge.click()
    expect(merge).to_contain_text('Codeup 结果尚未确认')
    merge.get_by_role('button', name='核对结果').click()
    expect(page.get_by_text('MR 已合并 · 已核对 Codeup')).to_be_visible()
    expect(page.get_by_text('b'*40)).to_be_visible()
    expect(page.get_by_role('button', name='关闭 MR', exact=True)).to_have_count(0)
    page.get_by_role('button', name='返回计划', exact=True).click()
    expect(page.get_by_text('代码已合并', exact=True)).to_be_visible()
    page.get_by_role('button', name='返回交付计划', exact=True).click()
    page.get_by_role('button', name='结算导出计划', exact=True).click()
    page.get_by_role('button', name='查看 MR !5').click()
    page.get_by_role('button', name='关闭 MR', exact=True).click()
    page.get_by_role('dialog', name='关闭 MR').get_by_role('button', name='确认关闭 MR').click()
    expect(page.get_by_text('MR 已关闭 · 已核对 Codeup')).to_be_visible()
    page.get_by_role('button', name='返回计划', exact=True).click()
    expect(page.get_by_text('已关闭', exact=True)).to_be_visible()
    assert actions == ['approve', 'merge', 'check', 'close']
    page.get_by_role('button', name='返回交付计划', exact=True).click()
    page.emulate_media(color_scheme='dark')
    page.set_viewport_size(dict(width=820, height=760))
    row = page.get_by_role('row').filter(has_text='术语复核')
    row.get_by_role('button', name='作废', exact=True).click()
    dialog = page.get_by_role('dialog', name='作废交付计划')
    expect(dialog).to_contain_text('术语复核')
    dialog.get_by_role('button', name='取消').click()
    assert 'voidedAt' not in plans['created']
    row.get_by_role('button', name='作废', exact=True).click()
    dialog.get_by_role('button', name='确认作废').click()
    expect(row).to_have_count(0)
    page.get_by_label('计划状态').select_option('voided')
    page.get_by_role('button', name='刷新', exact=True).click()
    expect(row).to_be_visible()
    expect(row.get_by_role('button', name='作废', exact=True)).to_have_count(0)
    print('PASS | plan and MR entry points, approval, merge and status check, close, and plan refresh')
