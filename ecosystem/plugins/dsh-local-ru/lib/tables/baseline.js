// Русский словарь для панели безопасности (dsh-baseline).
// Только видимый интерфейс: egress, baseline, fail-closed и имена API остаются
// на английском.
export const BASELINE_RU = {
    // Панель
    'panel.label': 'Аудит',
    'panel.title': 'Журнал решений',
    'panel.subtitle': 'Хеш-цепочка: каждое решение связано с предыдущим',

    // Состояние цепочки
    'status.chainUnknown': 'цепочка неизвестна',
    'status.chainUnavailable': 'цепочка недоступна',
    'status.chainOk': 'цепочка целостна',
    'status.chainStale': 'цепочка устарела',
    'status.chainBrokenAt': 'цепочка нарушена на записи',
    'status.verify': 'Проверить',
    'status.verifying': 'Проверяем…',
    'status.verified': 'Проверено',
    'status.records': 'Записей',
    'status.retention': 'Хранение',
    'status.range': 'Диапазон',
    'status.pruned': 'Устаревшие записи удалены',
    'status.fuse': 'Предохранитель',
    'status.degraded': 'Режим ограничен',

    // Вкладки
    'tabs.records': 'Записи',
    'tabs.policy': 'Политика',

    // Фильтры
    'filters.effect': 'Эффект',
    'filters.effectAll': 'все эффекты',
    'filters.tool': 'Инструмент',
    'filters.toolPlaceholder': 'имя инструмента',
    'filters.session': 'Сессия',
    'filters.sessionPlaceholder': 'id сессии',
    'filters.limit': 'Лимит',
    'filters.apply': 'Применить',
    'filters.reset': 'Сбросить',

    // Записи
    'records.exporting': 'Экспортируем…',
    'records.exportJson': 'Экспорт в JSON',
    'records.exportCsv': 'Экспорт в CSV',
    'records.exported': 'Экспортировано',
    'records.loading': 'Загружаем…',
    'records.empty': 'Записей нет',
    'records.page': 'Страница',
    'records.prev': 'Назад',
    'records.next': 'Вперёд',

    // Колонки
    'columns.time': 'Время',
    'columns.tool': 'Инструмент',
    'columns.effect': 'Эффект',
    'columns.risk': 'Риск',
    'columns.result': 'Результат',
    'columns.session': 'Сессия',

    // Эффекты
    'effect.allow': 'Разрешено',
    'effect.deny': 'Отклонено',
    'effect.ask': 'Требует подтверждения',
    'effect.fuse': 'Сработал предохранитель',

    // Риск
    'risk.low': 'низкий',
    'risk.medium': 'средний',
    'risk.high': 'высокий',
    'risk.critical': 'критический',

    // Результат
    'result.ok': 'ок',
    'result.error': 'ошибка',
    'result.denied': 'отклонено',
    'result.timeout': 'таймаут',

    // Детали
    'detail.time': 'Время',
    'detail.session': 'Сессия',
    'detail.agent': 'Агент',
    'detail.rule': 'Правило',
    'detail.reason': 'Причина',
    'detail.params': 'Параметры',
    'detail.chain': 'Цепочка',
    'detail.prevHash': 'Хеш предыдущей записи',
    'detail.hash': 'Хеш',
    'detail.feedback': 'Обратная связь',
    'detail.feedbackHint': 'Что оказалось неверным в решении?',
    'detail.feedbackPlaceholder': 'Опишите, что сработало не так',
    'detail.feedbackSubmit': 'Отправить',
    'detail.feedbackSubmitting': 'Отправляем…',
    'detail.feedbackDone': 'Спасибо, ответ сохранён',

    // Политика
    'policy.title': 'Политика',
    'policy.hint': 'Правила применяются к каждому вызову инструмента до его выполнения.',
    'policy.allowedHosts': 'Разрешённые хосты',
    'policy.allowedHostsHint': 'Куда агенту разрешено ходить по сети',
    'policy.blockedCIDRs': 'Заблокированные подсети',
    'policy.blockedCIDRsHint': 'Диапазоны, из которых исходящие запросы запрещены',
    'policy.saved': 'Сохранено',
    'policy.saving': 'Сохраняем…',
    'policy.save': 'Сохранить',
    'policy.revert': 'Вернуть значение по умолчанию',
    'policy.unsaved': 'несохранённые изменения',
    'policy.maxEgress': 'Лимит исходящих соединений',
    'policy.maxEgressHint': 'Сколько одновременных сетевых вызовов допустимо',
    'policy.unlimited': 'без ограничений',
    'policy.readonly': 'Только чтение',

    // Предохранитель
    'fuse.title': 'Предохранитель',
    'fuse.hint': 'Срабатывает при серии отказов подряд и временно останавливает решения.',
    'fuse.empty': 'Срабатываний не было',
    'fuse.count': 'Срабатываний',
    'fuse.reset': 'Сбросить',
    'fuse.resetDone': 'Сброшено',

    // Загрузка
    'boot.missingTitle': 'baseline не подключён',
    'boot.missingHint': 'Аудит решений недоступен: проверка цепочки не выполняется.',

    // Общие
    'common.refresh': 'Обновить',
    'common.retry': 'Повторить',
    'common.close': 'Закрыть',
};
