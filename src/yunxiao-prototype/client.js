window.__ModuleLoader__.load({
  id: 'dy-yunxiao-prototype',
  factory(require) {
    const h = require('react').createElement
    function Panel() {
      return h('iframe', {title:'云效议题原型', src:'/prototype/yunxiao'+location.search.replace(/token=[^&]*/g,''), style:{height:'100%',width:'100%',border:0,flex:1}})
    }
    return {inject:['slots'], apply(ctx) {
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({name:'sidebar.panellist',id:'yunxiao-prototype',label:'云效议题',order:40}, () => h('span',null,'☷')))
      ctx.slots.inject('main', () => ctx.slots.register({name:'main',key:'yunxiao-prototype'}, Panel))
    }}
  }
})
