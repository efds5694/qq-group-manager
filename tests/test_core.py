import csv
import io
import unittest

from app.core import exporter, template


class TemplateTests(unittest.TestCase):
    def test_context_and_unknown_variable(self):
        ctx = template.build_context({'nickname': '张三', 'qq': '10001'}, {'group_name': '测试群'}, 2)
        self.assertEqual(template.render('{group_name}-{nickname}-{index}-{missing}', ctx), '测试群-张三-2-{missing}')
        self.assertEqual(template.unknown_vars('{nickname}-{missing}'), ['missing'])

    def test_clamp_reports_truncation(self):
        self.assertEqual(template.clamp('  张三四五  ', 3), ('张三四', True))
        self.assertEqual(template.clamp('张三', 3), ('张三', False))

    def test_clamp_does_not_leave_whitespace_at_cutoff(self):
        value, clamped = template.clamp('张三 后缀', 3)
        self.assertTrue(clamped)
        self.assertEqual(value, '张三')
        self.assertEqual(template.clamp(value, 3)[0], value)


class ExportTests(unittest.TestCase):
    def test_csv_unicode_quoting_and_formula_protection(self):
        raw = exporter.rows_to_csv(['昵称'], [['张三,李四'], ['=1+1'], ['  @SUM(A1)']])
        self.assertTrue(raw.startswith(b'\xef\xbb\xbf'))
        self.assertEqual(list(csv.reader(io.StringIO(raw.decode('utf-8-sig')))),
                         [['昵称'], ['张三,李四'], ["'=1+1"], ["'  @SUM(A1)"]])

    def test_tsv_does_not_create_extra_cells(self):
        text = exporter.rows_to_tsv(['昵称'], [['张\t三\n李四'], ['+1']]).decode()
        self.assertEqual(text, "昵称\n张 三 李四\n'+1")

    def test_field_whitelist(self):
        self.assertEqual(exporter.normalize_fields(['token', 'qq']), ['qq'])

    @unittest.skipUnless(exporter._openpyxl_available(), 'optional openpyxl not installed')
    def test_xlsx_preserves_text_including_formulas_and_qq(self):
        from openpyxl import load_workbook
        raw = exporter.rows_to_xlsx(['昵称', 'QQ'], [['=1+1', '001234567890123456']], '群:[测试]/?')
        sheet = load_workbook(io.BytesIO(raw)).active
        self.assertEqual(sheet['A2'].value, '=1+1')
        self.assertEqual(sheet['A2'].data_type, 's')
        self.assertEqual(sheet['B2'].value, '001234567890123456')
